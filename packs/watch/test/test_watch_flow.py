"""Contracts of watch.main(): captions survive a failed media download, and aborts stay aborts."""
from __future__ import annotations

import json
import sys

import pytest

import media
import watch
import ytdlp

URL = "https://example.test/watch?v=abc"
DIAGNOSTIC = "[UNTRUSTED-MEDIA-TEXT inline kind=tool-diagnostic] ERROR: HTTP Error 403: Forbidden"
DOWNLOAD_FAILURE = f"yt-dlp produced no media file (exit 1). {DIAGNOSTIC}"
INSTALL_FAILURE = "\n".join([
    "yt-dlp is not installed and installing it automatically failed.",
    "  [UNTRUSTED-MEDIA-TEXT inline kind=tool-diagnostic] ERROR: no network",
    "Install it yourself, then retry:",
    f'  Any OS:  "{sys.executable}" -m pip install -U yt-dlp',
])
CAPTIONS_VTT = "\n".join([
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:03.000",
    "Welcome to the talk",
    "",
    "00:00:04.000 --> 00:00:06.000",
    "Today we cover captions",
    "",
    "00:00:07.000 --> 00:00:09.000",
    "Thanks for watching",
    "",
])
CUELESS_VTT = "WEBVTT\n\n"


class FakeMedia:
    def __init__(self, captions, download_error):
        self.captions = captions
        self.download_error = download_error
        self.fetch_calls = []
        self.download_calls = []

    def fetch_captions(self, url, out_dir):
        self.fetch_calls.append(url)
        return self.captions

    def download(self, source, out_dir, audio_only=False):
        self.download_calls.append(source)
        raise SystemExit(self.download_error)


def forbidden(*args, **kwargs):
    raise AssertionError("frame or probe work must not run without a video file")


@pytest.fixture
def isolated_watch(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "require", lambda binary: None)
    monkeypatch.setattr(watch, "WORK_ROOT", tmp_path / "work")
    monkeypatch.setattr(media, "get_metadata", forbidden)
    monkeypatch.setattr(media, "select_frames", forbidden)
    monkeypatch.setattr(media, "extract_at", forbidden)
    return tmp_path


@pytest.fixture
def arm_media(monkeypatch, isolated_watch):
    def install(*, captions_text=None, download_error):
        subtitle_path = None
        if captions_text is not None:
            vtt = isolated_watch / "captions.vtt"
            vtt.write_bytes(captions_text.encode("utf-8"))
            subtitle_path = str(vtt)
        captions = {
            "video_path": None,
            "subtitle_path": subtitle_path,
            "info": {"title": "T", "duration": 120},
        }
        fake = FakeMedia(captions, download_error)
        monkeypatch.setattr(media, "fetch_captions", fake.fetch_captions)
        monkeypatch.setattr(media, "download", fake.download)
        return fake

    return install


def invoke(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["watch", *argv])
    return watch.main()


@pytest.mark.parametrize(
    "failure",
    [
        pytest.param(DOWNLOAD_FAILURE, id="single-line failure"),
        pytest.param(INSTALL_FAILURE, id="multi-line install failure"),
    ],
)
def test_captions_carry_the_report_when_the_media_download_fails(
    monkeypatch, capsys, arm_media, failure
):
    fake = arm_media(captions_text=CAPTIONS_VTT, download_error=failure)

    code = invoke(monkeypatch, "--json", URL, "--detail", "balanced")

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert fake.download_calls == [URL]
    assert payload["frames"] == []
    assert payload["transcriptSegments"] == 3
    assert payload["transcriptSource"] == "captions"
    assert payload["title"] == "T"
    assert payload["durationSeconds"] == 120
    assert "Welcome to the talk" in payload["report"]
    notice = next(line for line in payload["report"].splitlines() if "Frames unavailable" in line)
    assert " ".join(failure.split()) in notice


def test_transcript_detail_with_captions_never_downloads_media(monkeypatch, capsys, arm_media):
    fake = arm_media(captions_text=CAPTIONS_VTT, download_error="download must not be attempted")

    code = invoke(monkeypatch, "--json", URL, "--detail", "transcript")

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert fake.fetch_calls == [URL]
    assert fake.download_calls == []
    assert payload["frames"] == []
    assert payload["transcriptSegments"] == 3
    assert "Frames unavailable" not in payload["report"]


@pytest.mark.parametrize(
    "captions_text",
    [
        pytest.param(None, id="no captions file"),
        pytest.param(CUELESS_VTT, id="captions file without a single cue"),
    ],
)
def test_a_failed_download_aborts_the_run_when_there_is_no_transcript_to_fall_back_on(
    monkeypatch, capsys, arm_media, captions_text
):
    arm_media(captions_text=captions_text, download_error=DOWNLOAD_FAILURE)

    with pytest.raises(SystemExit) as exit_info:
        invoke(monkeypatch, "--json", URL, "--detail", "balanced")

    assert str(exit_info.value) == DOWNLOAD_FAILURE
    assert capsys.readouterr().out == ""


def test_a_failed_download_is_never_swallowed_for_a_local_file(
    monkeypatch, capsys, isolated_watch, arm_media
):
    clip = isolated_watch / "clip.mp4"
    clip.write_bytes(b"not really a video")
    fake = arm_media(captions_text=CAPTIONS_VTT, download_error="could not read the file")

    with pytest.raises(SystemExit) as exit_info:
        invoke(monkeypatch, "--json", str(clip), "--detail", "balanced")

    assert str(exit_info.value) == "could not read the file"
    assert fake.fetch_calls == []
    assert fake.download_calls == [str(clip)]
    assert capsys.readouterr().out == ""


def test_the_report_says_when_software_was_installed_or_upgraded_on_this_run(
    monkeypatch, capsys, arm_media
):
    note = "upgraded yt-dlp 2026.10.26 for this user account (pip --user, /usr/bin/python3)"
    monkeypatch.setattr(ytdlp, "_events", [note])
    arm_media(captions_text=CAPTIONS_VTT, download_error="download must not be attempted")

    invoke(monkeypatch, "--json", URL, "--detail", "transcript")

    payload = json.loads(capsys.readouterr().out)
    assert f"- **Software changed on this run:** {note}" in payload["report"].splitlines()


def test_the_report_names_no_software_change_when_nothing_was_installed(
    monkeypatch, capsys, arm_media
):
    monkeypatch.setattr(ytdlp, "_events", [])
    arm_media(captions_text=CAPTIONS_VTT, download_error="download must not be attempted")

    invoke(monkeypatch, "--json", URL, "--detail", "transcript")

    payload = json.loads(capsys.readouterr().out)
    assert "Software changed" not in payload["report"]
