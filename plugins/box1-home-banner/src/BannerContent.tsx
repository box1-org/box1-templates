import { MarkdownContent } from '@backstage/core-components';

/**
 * Props arrive from `widgetLayout.box1-operations-banner.props` in app-config,
 * so the banner text (and the `${BOX1_ICON_LOGO}` data URI substituted by the
 * backend config loader) stays in box1-gitops rather than in this package.
 */
export type BannerContentProps = {
  content?: string;
};

const fallback = [
  '## Box1 Operations Hub',
  'Self-service delivery and day-2 operations for the Box1 OpenShift lab, powered by Red Hat Developer Hub.',
].join('\n\n');

export const BannerContent = ({ content }: BannerContentProps) => (
  <MarkdownContent content={content ?? fallback} dialect="gfm" />
);
