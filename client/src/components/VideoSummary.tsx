import { useVideoSummary } from '../hooks/useVideoSummary';

interface VideoSummaryProps {
  baseName: string | undefined;
  subtitlePath: string | undefined;
}

export default function VideoSummary({
  baseName,
  subtitlePath,
}: VideoSummaryProps): JSX.Element | null {
  const { state: summaryState } = useVideoSummary(baseName, subtitlePath);

  if (!subtitlePath || !summaryState.summary) {
    return null;
  }

  return (
    <div className="video-summary-section">
      <h2>Summary</h2>
      <div className="summary-content">
        <p>{summaryState.summary}</p>
      </div>
    </div>
  );
}
