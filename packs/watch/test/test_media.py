"""Contracts of media.py: acquisition via yt-dlp, subtitle choice, stale-file hygiene, frame dedup."""
from __future__ import annotations

import json
import shutil
import types
from pathlib import Path

import pytest

import media
import proc

URL = "https://example.test/watch?v=abc"
LABEL = "[UNTRUSTED-MEDIA-TEXT inline kind=tool-diagnostic]"

requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")


def touch(directory: Path, *names: str) -> None:
    for name in names:
        (directory / name).write_text("", encoding="utf-8")


class FakeYtDlp:
    def __init__(self, out_dir, result, writes):
        self.out_dir = out_dir
        self.result = result
        self.writes = writes
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        for name, content in self.writes.items():
            (self.out_dir / name).write_text(content, encoding="utf-8")
        return self.result


@pytest.fixture
def fake_ytdlp(monkeypatch):
    def install(out_dir, result, files=None):
        fake = FakeYtDlp(out_dir, result, files or {})
        monkeypatch.setattr(media.ytdlp, "run", fake)
        return fake

    return install


@pytest.mark.parametrize(
    ("present", "expected"),
    [
        pytest.param(
            ["video.en-orig.vtt", "video.en.vtt", "video.en-GB.vtt", "video.en-en.vtt"],
            "video.en.vtt",
            id="plain en beats every variant",
        ),
        pytest.param(
            ["video.en-GB.vtt", "video.en-US.vtt", "video.en-orig.vtt"],
            "video.en-orig.vtt",
            id="en-orig beats en-US and en-GB",
        ),
        pytest.param(
            ["video.en-GB.vtt", "video.en-US.vtt"],
            "video.en-US.vtt",
            id="en-US beats en-GB",
        ),
        pytest.param(
            ["video.en-de.vtt", "video.en-en.vtt"],
            "video.en-de.vtt",
            id="only non-preferred names fall back to alphabetical",
        ),
        pytest.param(
            ["video.info.json", "video.en.json", "video.en-de.vtt"],
            "video.en-de.vtt",
            id="json files are never subtitles",
        ),
        pytest.param(["other.en.vtt"], None, id="subtitles of another basename are ignored"),
        pytest.param(["video.info.json"], None, id="no subtitle at all"),
        pytest.param([], None, id="empty directory"),
    ],
)
def test_pick_subtitle_prefers_plain_english_then_the_documented_variants(tmp_path, present, expected):
    touch(tmp_path, *present)

    picked = media._pick_subtitle(tmp_path)

    assert (picked.name if picked else None) == expected


def test_clear_stale_media_removes_media_and_partials_but_keeps_captions_and_unrelated_files(tmp_path):
    stale = ["video.mp4", "video.webm", "video.mp4.part", "video.f137.mp4.ytdl", "video.m4a"]
    kept = ["video.en.vtt", "video.info.json", "notes.txt", "frame_00001.jpg"]
    touch(tmp_path, *stale, *kept)

    media._clear_stale_media(tmp_path)

    assert sorted(entry.name for entry in tmp_path.iterdir()) == sorted(kept)


@pytest.mark.parametrize("failure", [FileNotFoundError, PermissionError], ids=["vanished", "locked"])
def test_clear_stale_media_survives_a_file_it_cannot_remove_and_still_clears_the_rest(
    tmp_path, monkeypatch, failure
):
    touch(tmp_path, "video.mp4", "video.webm", "video.en.vtt")
    real_unlink = Path.unlink

    def unlink(self, *args, **kwargs):
        if self.name == "video.mp4":
            raise failure(self.name)
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)

    media._clear_stale_media(tmp_path)

    assert not (tmp_path / "video.webm").exists()
    assert (tmp_path / "video.en.vtt").exists()


def test_download_never_reuses_media_left_behind_by_an_earlier_run(tmp_path, completed, fake_ytdlp):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    stale = out_dir / "video.mp4"
    stale.write_bytes(b"left over from a previous run")
    fake_ytdlp(out_dir, completed(1, stderr="ERROR: x"))

    with pytest.raises(SystemExit) as exit_info:
        media.download(URL, out_dir)

    message = str(exit_info.value)
    assert "yt-dlp produced no media file" in message
    assert LABEL in message
    assert not stale.exists()


def test_download_returns_the_new_media_when_an_older_file_has_a_preferred_extension(
    tmp_path, completed, fake_ytdlp
):
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "video.mp4").write_bytes(b"stale")
    fake_ytdlp(out_dir, completed(0), {"video.webm": "fresh"})

    result = media.download(URL, out_dir)

    assert Path(result["video_path"]) == out_dir / "video.webm"
    assert not (out_dir / "video.mp4").exists()


def test_download_hands_yt_dlp_the_url_after_a_double_dash_and_the_out_dir_as_home_path(
    tmp_path, completed, fake_ytdlp
):
    out_dir = tmp_path / "out"
    fake = fake_ytdlp(out_dir, completed(0), {"video.mp4": "media"})

    media.download(URL, out_dir)

    args = fake.calls[0]
    assert args[-2:] == ["--", URL]
    assert args[args.index("-P") + 1] == f"home:{out_dir}"


def test_fetch_captions_downloads_no_media_and_returns_the_written_subtitle_and_info(
    tmp_path, completed, fake_ytdlp
):
    out_dir = tmp_path / "out"
    info = json.dumps({"title": "A talk", "uploader": "Ada", "duration": 61})
    fake = fake_ytdlp(
        out_dir, completed(0), {"video.en.vtt": "WEBVTT\n", "video.info.json": info}
    )

    result = media.fetch_captions(URL, out_dir)

    args = fake.calls[0]
    assert "--skip-download" in args
    assert "--write-info-json" in args
    assert args[-2:] == ["--", URL]
    assert result["video_path"] is None
    assert Path(result["subtitle_path"]) == out_dir / "video.en.vtt"
    assert result["info"]["title"] == "A talk"


def test_require_names_ffmpeg_and_its_install_command_when_it_is_missing(monkeypatch):
    monkeypatch.setattr(media, "shutil", types.SimpleNamespace(which=lambda binary: None))

    with pytest.raises(SystemExit) as exit_info:
        media.require("ffmpeg")

    message = str(exit_info.value)
    assert "ffmpeg is not on PATH" in message
    assert "winget install Gyan.FFmpeg" in message
    assert "yt-dlp" not in message.lower()


def test_require_returns_quietly_when_the_binary_exists(monkeypatch):
    monkeypatch.setattr(media, "shutil", types.SimpleNamespace(which=lambda binary: f"/bin/{binary}"))

    assert media.require("ffmpeg") is None


@pytest.fixture(scope="session")
def swatches(tmp_path_factory):
    directory = tmp_path_factory.mktemp("swatches")
    colors = {"red": "0xC83C3C", "green": "0x3C833C"}
    paths = {}
    for name, color in colors.items():
        path = directory / f"{name}.jpg"
        result = proc.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", f"color=c={color}:s=320x180:d=0.1", "-frames:v", "1", str(path),
        ])
        assert result.returncode == 0, result.stderr
        paths[name] = path
    return paths


def stage_frames(directory: Path, swatches: dict, *colors: str) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    for index, color in enumerate(colors):
        path = directory / f"frame_{index + 1:05d}.jpg"
        shutil.copy(swatches[color], path)
        frames.append({"path": str(path), "timestamp_seconds": float(index), "reason": "uniform"})
    return frames


@requires_ffmpeg
def test_dedup_keeps_frames_that_share_luminance_but_differ_in_hue(tmp_path, swatches):
    frames = stage_frames(tmp_path, swatches, "red", "green")

    kept, dropped = media.dedup(frames)

    assert kept == frames
    assert dropped == 0
    assert all(Path(frame["path"]).exists() for frame in frames)


@requires_ffmpeg
def test_dedup_drops_and_deletes_a_frame_identical_to_the_last_kept_one(tmp_path, swatches):
    frames = stage_frames(tmp_path, swatches, "red", "red")

    kept, dropped = media.dedup(frames)

    assert kept == [frames[0]]
    assert dropped == 1
    assert Path(frames[0]["path"]).exists()
    assert not Path(frames[1]["path"]).exists()
    assert not (tmp_path / "dedup.txt").exists()


@requires_ffmpeg
def test_dedup_keeps_the_first_frame_of_each_run_of_identical_frames_in_order(tmp_path, swatches):
    frames = stage_frames(tmp_path, swatches, "red", "red", "green", "green")

    kept, dropped = media.dedup(frames)

    assert kept == [frames[0], frames[2]]
    assert dropped == 2


@requires_ffmpeg
def test_dedup_still_runs_when_the_out_dir_contains_an_apostrophe(tmp_path, swatches):
    frames = stage_frames(tmp_path / "o'brien", swatches, "red", "red")

    kept, dropped = media.dedup(frames)

    assert kept == [frames[0]]
    assert dropped == 1
    assert not Path(frames[1]["path"]).exists()


def stage_flat_frames(directory: Path, *levels: int) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    for index, level in enumerate(levels):
        path = directory / f"frame_{index + 1:05d}.ppm"
        path.write_bytes(b"P6\n16 16\n255\n" + bytes([level] * 3) * 256)
        frames.append({"path": str(path), "timestamp_seconds": float(index), "reason": "uniform"})
    return frames


@requires_ffmpeg
def test_dedup_catches_a_slow_fade_by_measuring_against_the_last_kept_frame(tmp_path):
    step = int(media.DEDUP_THRESHOLD)
    frames = stage_flat_frames(tmp_path, 100, 100 + step, 100 + 2 * step)

    kept, dropped = media.dedup(frames)

    assert kept == [frames[0], frames[2]]
    assert dropped == 1
