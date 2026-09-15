import { stripVttCueSettings, vttLanguage } from './vttUtils';

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
