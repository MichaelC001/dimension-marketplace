"""Contracts of transcript.parse_captions and format_transcript."""
from __future__ import annotations

import pytest

import transcript

YOUTUBE_ROLLING_VTT = "\n".join([
    "WEBVTT",
    "Kind: captions",
    "Language: en",
    "",
    "00:00:01.520 --> 00:00:04.630 align:start position:0%",
    " ",
    "there<00:00:02.000><c> is</c><00:00:02.240><c> a</c><00:00:02.399><c> hole</c>",
    "",
    "00:00:04.630 --> 00:00:04.640 align:start position:0%",
    "there is a hole",
    " ",
    "",
    "00:00:04.640 --> 00:00:07.190 align:start position:0%",
    "there is a hole",
    "a<00:00:04.799><c> hole</c><00:00:05.440><c> that</c>",
    "",
    "00:00:07.190 --> 00:00:07.200 align:start position:0%",
    "a hole that",
    " ",
    "",
])

NUMERIC_CUE_VTT = "\n".join([
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "at least",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "20",
    "",
    "00:00:03.000 --> 00:00:04.000",
    "hours",
    "",
])

NUMERIC_CUE_SRT = "\n".join([
    "1",
    "00:00:01,000 --> 00:00:02,000",
    "at least",
    "",
    "2",
    "00:00:02,000 --> 00:00:03,000",
    "20",
    "",
    "3",
    "00:00:03,000 --> 00:00:04,000",
    "hours",
    "",
])

NON_CAPTION_BLOCKS_VTT = "\n".join([
    "WEBVTT - an example title",
    "Kind: captions",
    "Language: en",
    "",
    "NOTE",
    "this is a note",
    "spanning two lines",
    "",
    "STYLE",
    "::cue { color: red }",
    "",
    "intro",
    "00:00:01.000 --> 00:00:02.000",
    "Hello",
    "",
    "42",
    "00:00:03.000 --> 00:00:04.000",
    "World",
    "",
])

ROLLING_GAP_MS = round(transcript.ROLLING_GAP_SECONDS * 1000)


@pytest.fixture
def parse(tmp_path):
    def run(content, name="captions.vtt"):
        path = tmp_path / name
        payload = content if isinstance(content, bytes) else content.encode("utf-8")
        path.write_bytes(payload)
        return transcript.parse_captions(path)

    return run


def texts(segments):
    return [segment["text"] for segment in segments]


def clock(milliseconds):
    seconds, ms = divmod(milliseconds, 1000)
    minutes, sec = divmod(seconds, 60)
    hours, minute = divmod(minutes, 60)
    return f"{hours:02d}:{minute:02d}:{sec:02d}.{ms:03d}"


def one_cue(text):
    return f"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{text}\n"


def test_youtube_rolling_auto_captions_collapse_to_one_segment_per_spoken_line(parse):
    segments = parse(YOUTUBE_ROLLING_VTT)

    assert texts(segments) == ["there is a hole", "a hole that"]
    assert [segment["start"] for segment in segments] == pytest.approx([1.52, 4.64])


@pytest.mark.parametrize(
    ("content", "name"),
    [
        pytest.param(NUMERIC_CUE_VTT, "captions.vtt", id="vtt"),
        pytest.param(NUMERIC_CUE_SRT, "captions.srt", id="srt with numeric cue indexes"),
    ],
)
def test_a_spoken_number_is_kept_while_srt_cue_indexes_are_not_caption_text(parse, content, name):
    assert texts(parse(content, name)) == ["at least", "20", "hours"]


def test_header_note_style_and_cue_identifiers_are_never_caption_text(parse):
    assert texts(parse(NON_CAPTION_BLOCKS_VTT)) == ["Hello", "World"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param(
            "&gt;&gt; Hello &amp; welcome&nbsp;back",
            ">> Hello & welcome back",
            id="entities decode and nbsp becomes a space",
        ),
        pytest.param(
            "Use &lt;b&gt; for bold",
            "Use <b> for bold",
            id="escaped tag stays literal text",
        ),
        pytest.param(
            "<b>bold</b> and <c.colorE5E5E5>colored</c>",
            "bold and colored",
            id="real tags are stripped",
        ),
        pytest.param(
            "AT&amp;T &amp;lt;3",
            "AT&T &lt;3",
            id="entities decode exactly once",
        ),
    ],
)
def test_tags_are_stripped_before_entities_are_decoded(parse, raw, expected):
    assert texts(parse(one_cue(raw))) == [expected]


def test_a_utf8_byte_order_mark_does_not_hide_the_first_cue(parse):
    body = "00:00:01.000 --> 00:00:02.000\nHello\n"

    segments = parse(b"\xef\xbb\xbf" + body.encode("utf-8"))

    assert texts(segments) == ["Hello"]
    assert segments[0]["start"] == pytest.approx(1.0)


@pytest.mark.parametrize(
    ("gap_ms", "expected_count"),
    [
        pytest.param(0, 1, id="re-rendered the instant the previous showing ended"),
        pytest.param(ROLLING_GAP_MS, 1, id="re-rendered exactly at the gap limit"),
        pytest.param(ROLLING_GAP_MS + 1, 2, id="one millisecond past the gap limit"),
        pytest.param(4000, 2, id="said again after a pause"),
    ],
)
def test_a_repeated_line_collapses_only_when_it_restarts_within_the_rolling_gap(
    parse, gap_ms, expected_count
):
    first_end = 1000
    second_start = first_end + gap_ms
    content = "\n".join([
        "WEBVTT",
        "",
        f"{clock(0)} --> {clock(first_end)}",
        "No.",
        "",
        f"{clock(second_start)} --> {clock(second_start + 1000)}",
        "No.",
        "",
    ])

    assert texts(parse(content)) == ["No."] * expected_count


@pytest.mark.parametrize(
    ("timing", "start", "end"),
    [
        pytest.param("00:01:05.250 --> 00:01:07.500", 65.25, 67.5, id="hours present"),
        pytest.param("01:05.250 --> 01:07.500", 65.25, 67.5, id="hours omitted as whisper writes"),
        pytest.param("00:01:05,250 --> 00:01:07,500", 65.25, 67.5, id="srt comma separator"),
        pytest.param("01:05,250 --> 01:07,500", 65.25, 67.5, id="comma separator without hours"),
        pytest.param("1:02:03.004 --> 1:02:04.000", 3723.004, 3724.0, id="single digit hour"),
        pytest.param("00:00:01.5 --> 00:00:02.25", 1.5, 2.25, id="short fractions are tenths not thousandths"),
    ],
)
def test_cue_timings_parse_with_optional_hours_comma_separators_and_short_fractions(
    parse, timing, start, end
):
    segments = parse(f"WEBVTT\n\n{timing}\nhello\n")

    assert texts(segments) == ["hello"]
    assert segments[0]["start"] == pytest.approx(start)
    assert segments[0]["end"] == pytest.approx(end)


def test_format_transcript_stamps_minutes_and_seconds_and_adds_hours_past_one_hour():
    segments = [
        {"start": 1.0, "end": 2.0, "text": "text"},
        {"start": 3605.0, "end": 3606.0, "text": "later"},
    ]

    assert transcript.format_transcript(segments) == "[00:01] text\n[1:00:05] later"
