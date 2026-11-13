import { MarkdownContent } from '@backstage/core-components';

/**
 * Props arrive from `widgetLayout.box1-operations-banner.props` in app-config,
 * so the banner text and logo stay in box1-gitops rather than in this package.
 *
 * The logo is rendered as its own <img>, not inside the Markdown: RHDH 2.1's
 * MarkdownContent (react-markdown 8 + rehype-sanitize) allows only http(s),
 * mailto and tel URLs, so a `data:` image URI in Markdown renders as a broken
 * image. `logo` is the `${BOX1_ICON_LOGO}` data URI substituted by the backend.
 */
export type BannerContentProps = {
  content?: string;
  logo?: string;
  logoAlt?: string;
};

const fallback = [
  '## Box1 Operations Hub',
  'Self-service delivery and day-2 operations for the Box1 OpenShift lab, powered by Red Hat Developer Hub.',
].join('\n\n');

// Accept only image data URIs and https URLs for the logo.
const safeLogo = (logo?: string) =>
  logo && /^(data:image\/(png|svg\+xml|jpeg|webp);base64,|https:\/\/)/.test(logo)
    ? logo
    : undefined;

export const BannerContent = ({ content, logo, logoAlt }: BannerContentProps) => {
  const src = safeLogo(logo);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
      {src && (
        <img
          src={src}
          alt={logoAlt ?? 'Box1'}
          style={{ width: 96, height: 96, flex: '0 0 auto', objectFit: 'contain' }}
        />
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <MarkdownContent content={content ?? fallback} dialect="gfm" />
      </div>
    </div>
  );
};
