import { findSubtitleFiles, isOwnSubtitleName, stripVttCueSettings, vttLanguage } from './vttUtils';

/** A realistic yt-dlp auto-caption file: settings on cues, tags, plain text */
const YTDLP_VTT = `WEBVTT
Kind: captions
Language: en

00:00:03.360 --> 00:00:05.200 align:start position:0%
<00:00:03.360><c>some</c><00:00:04.640><c>text</c>

00:00:05.200 --> 00:00:07.600 align:start position:0%
more text

00:00:07.600 --> 00:00:09.800
centered already
`;

describe('stripVttCueSettings', () => {
  it('drops position/align settings from cue timings', () => {
    expect(stripVttCueSettings(YTDLP_VTT)).toBe(`WEBVTT
Kind: captions
Language: en

00:00:03.360 --> 00:00:05.200
<00:00:03.360><c>some</c><00:00:04.640><c>text</c>

00:00:05.200 --> 00:00:07.600
more text

00:00:07.600 --> 00:00:09.800
centered already
`);
  });

  it('keeps timings that have no settings exactly as they are', () => {
    expect(stripVttCueSettings('00:00:01.000 --> 00:00:02.000\n')).toBe('00:00:01.000 --> 00:00:02.000\n');
  });

  it('accepts hour-less timestamps and trailing spaces', () => {
    expect(stripVttCueSettings('00:03.360 --> 00:05.200 line:0% \ntext')).toBe('00:03.360 --> 00:05.200\ntext');
  });

  it('leaves text lines containing --> untouched', () => {
    const content = 'WEBVTT\n\nnote --> but not a cue\n\na -> b';
    expect(stripVttCueSettings(content)).toBe(content);
  });

  it('preserves other cue settings-free lines and CRLF where present', () => {
    expect(stripVttCueSettings('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000 align:start\r\ntext')).toBe(
      'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\ntext',
    );
  });

  it('is idempotent', () => {
    const once = stripVttCueSettings(YTDLP_VTT);
    expect(stripVttCueSettings(once)).toBe(once);
  });
});

describe('vttLanguage', () => {
  it('reads the language from yt-dlp subtitle file names', () => {
    expect(vttLanguage('20260906_Some_Title.en.vtt')).toBe('en');
    expect(vttLanguage('20260906_Some_Title.pl.vtt')).toBe('pl');
    expect(vttLanguage('20260906_Some_Title.en-US.vtt')).toBe('en-US');
  });

  it('returns undefined without a language suffix', () => {
    expect(vttLanguage('20260906_Some_Title.vtt')).toBeUndefined();
    expect(vttLanguage('20260906_Some_Title.mp4')).toBeUndefined();
  });
});

describe('isOwnSubtitleName', () => {
  it('accepts only the subtitle names of its own stem', () => {
    for (const name of ['20240101_Talk.vtt', '20240101_Talk.en.vtt', '20240101_Talk.en-orig.vtt']) {
      expect(isOwnSubtitleName('20240101_Talk', name), name).toBe(true);
    }
    // A sibling's track, another stem, a walk out of the folder, a path
    // (the language part holds no dot, but may hold a slash) and another file
    for (const name of [
      '20240101_Talk.info.json',
      '20240101_Talk.5.en.vtt',
      '20240101_Other.en.vtt',
      '../20240101_Talk.en.vtt',
      '20240101_Talk.sub/x.vtt',
      'notes.txt',
    ]) {
      expect(isOwnSubtitleName('20240101_Talk', name), name).toBe(false);
    }
  });
});

describe('findSubtitleFiles', () => {
  it("takes the stem's own captions in listing order, the plain one without a language too", () => {
    expect(
      findSubtitleFiles('X', ['X.mp4', 'X.pl.vtt', 'X.vtt', 'X.en-US.vtt', 'X.en.srt', 'XY.en.vtt', 'Other.en.vtt']),
    ).toEqual(['X.pl.vtt', 'X.vtt', 'X.en-US.vtt']);
  });

  it('never takes the captions of a sibling video whose stem extends this one', () => {
    // No language code holds a dot, so X.5.en.vtt is the sibling X.5's
    expect(findSubtitleFiles('X', ['X.mp4', 'X.5.info.json', 'X.5.en.vtt', 'X.5.vtt'])).toEqual([]);
    // A sibling with media and no info.json is a video all the same, in any case
    expect(findSubtitleFiles('X', ['X.en.vtt', 'X.5.vtt', 'X.5.MKV'])).toEqual(['X.en.vtt']);
    // Any part can make one, as "Version 2.0 beta" beside "Version 2" does
    expect(findSubtitleFiles('V_2', ['V_2.en.vtt', 'V_2.0_beta.info.json', 'V_2.0_beta.vtt'])).toEqual(['V_2.en.vtt']);
    // An image alone makes no video, so the part reads as a language
    expect(findSubtitleFiles('X', ['X.5.vtt', 'X.5.webp'])).toEqual(['X.5.vtt']);
  });

  it('keeps its own captions beside a twin video whose title ends in their language', () => {
    // "Talk" and "Talk.en" from one day: yt-dlp never writes a plain track, so
    // Talk.en.vtt is Talk's English one, while Talk.en.en.vtt is the twin's
    const listing = ['Talk.info.json', 'Talk.mp4', 'Talk.en.vtt', 'Talk.en.info.json', 'Talk.en.mp4', 'Talk.en.en.vtt'];
    expect(findSubtitleFiles('Talk', listing)).toEqual(['Talk.en.vtt']);
    expect(findSubtitleFiles('Allegro', ['Allegro.mp4', 'Allegro.pl.vtt', 'Allegro.pl.mkv'])).toEqual([
      'Allegro.pl.vtt',
    ]);
  });

  it('reads any iterable of names, the folder index passes a set', () => {
    expect(findSubtitleFiles('X', new Set(['X.mp4', 'X.en.vtt']))).toEqual(['X.en.vtt']);
  });
});
