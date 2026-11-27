import { titleFromStem } from './videoStem';

describe('titleFromStem', () => {
  it('turns a stem without an id into its title', () => {
    expect(titleFromStem('20130526_Home_built_SMD_Reflow_Oven', 'Dube38fpLtc')).toBe('Home built SMD Reflow Oven');
  });

  it("drops the id a stem ends in when it is this video's, whatever the id holds", () => {
    expect(titleFromStem('20260101_Some_title__abcdefghij', '_abcdefghij')).toBe('Some title');
    expect(titleFromStem('20231201_Test_Video1_-abc_def-gh', '-abc_def-gh')).toBe('Test Video1');
  });

  it('keeps a last word that is not the id', () => {
    expect(titleFromStem('20231201_Lesson_Programming', 'xyzXYZ01234')).toBe('Lesson Programming');
  });

  it('drops the placeholder yt-dlp writes for a video with no upload date', () => {
    expect(titleFromStem('NA_Live_stream_abcdefghijk', 'abcdefghijk')).toBe('Live stream');
  });
});
