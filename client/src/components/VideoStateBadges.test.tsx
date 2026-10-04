import { render, screen } from '@testing-library/react';
import type { DownloadState } from '@videodeck/shared/api';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { missingSummary } from '../utils/videoState';
import { VideoStateBadges } from './VideoStateBadges';

/** A video on disk, complete unless the test says otherwise */
const state = (overrides: Partial<DownloadState> = {}): DownloadState => ({
  files: {
    video: true,
    thumbnail: true,
    description: true,
    subLangs: ['en', 'pl'],
    comments: true,
    videoBytes: 1048576,
    infoBytes: 2048,
  },
  archive: { onDisk: true, inArchive: true, drift: false },
  missing: [],
  ...overrides,
});

const badge = (text: string): HTMLElement => screen.getByText(text);

describe('VideoStateBadges', () => {
  it('lists what the video has on disk', () => {
    render(<VideoStateBadges state={state()} />);

    expect(badge(i18n.t('videoState.badge.video'))).toBeInTheDocument();
    expect(badge(i18n.t('videoState.badge.thumbnail'))).toBeInTheDocument();
    expect(badge(i18n.t('videoState.badge.description'))).toBeInTheDocument();
    // The subtitle languages are named on the row itself, not counted
    expect(badge(i18n.t('videoState.badge.subs', { langs: 'en, pl' }))).toBeInTheDocument();
    expect(badge(i18n.t('videoState.badge.comments'))).toBeInTheDocument();
    expect(screen.queryByText(/missing/)).toBeNull();
  });

  it('leaves out the sidecars the video does not have', () => {
    render(
      <VideoStateBadges
        state={state({
          files: {
            video: true,
            thumbnail: false,
            description: false,
            subLangs: [],
            comments: false,
            videoBytes: 0,
            infoBytes: 0,
          },
          missing: ['thumbnail', 'description', 'comments', 'pl'],
        })}
      />,
    );

    expect(badge(i18n.t('videoState.badge.video'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('videoState.badge.thumbnail'))).toBeNull();
    expect(screen.queryByText(i18n.t('videoState.badge.subs', { langs: '' }))).toBeNull();
  });

  it('names what is missing in a warning badge', () => {
    const missing = ['thumbnail', 'pl'];
    render(<VideoStateBadges state={state({ missing })} />);

    const warning = badge(missingSummary(missing, i18n.t));
    expect(warning).toHaveClass('video-state-badge--warn');
  });

  it('says a video is not downloaded instead of listing empty sidecars', () => {
    render(<VideoStateBadges state={state({ files: null, missing: [] })} />);

    expect(badge(i18n.t('videoState.badge.notDownloaded'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('videoState.badge.video'))).toBeNull();
  });

  it('names the reason a video cannot arrive instead of calling it not downloaded', () => {
    render(<VideoStateBadges state={state({ files: null, missing: [] })} availability="subscriber_only" />);

    const membersOnly = badge(i18n.t('videoState.badge.membersOnly'));
    expect(membersOnly).toHaveClass('video-state-badge--info');
    expect(screen.queryByText(i18n.t('videoState.badge.notDownloaded'))).toBeNull();
  });

  it('names Premium as the reason when that is what the catalog says', () => {
    render(<VideoStateBadges state={state({ files: null, missing: [] })} availability="premium_only" />);

    expect(badge(i18n.t('videoState.badge.premiumOnly'))).toBeInTheDocument();
  });

  it('keeps the file badges of a video that is on disk, whatever the catalog says', () => {
    render(<VideoStateBadges state={state()} availability="subscriber_only" />);

    expect(badge(i18n.t('videoState.badge.video'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('videoState.badge.membersOnly'))).toBeNull();
  });

  it('renders nothing while the folder state is not there', () => {
    const { container } = render(<VideoStateBadges state={undefined} />);

    expect(container.innerHTML).toBe('');
  });
});
