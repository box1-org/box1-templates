/*
 * Box1 Operations banner for the RHDH 2.1 homepage (New Frontend System).
 *
 * The widget attaches to the homepage plugin's `page:homepage` widgets input,
 * like the built-in RHDH cards. Its extension name `box1-operations-banner` is
 * the `ref` used by `homepage.defaultWidgets` and the key used by the
 * `home-page-layout:homepage/dynamic-homepage-layout` `widgetLayout` config,
 * which forwards `props` (title, content) on a read-only homepage.
 */
import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { HomePageWidgetBlueprint } from '@backstage/plugin-home-react/alpha';

export const box1OperationsBanner = HomePageWidgetBlueprint.make({
  name: 'box1-operations-banner',
  attachTo: { id: 'page:homepage', input: 'widgets' },
  params: {
    name: 'Box1 Operations',
    layout: {
      width: { minColumns: 4, maxColumns: 12, defaultColumns: 12 },
      height: { minRows: 2, maxRows: 12, defaultRows: 4 },
    },
    components: () =>
      import('./BannerContent').then(m => ({ Content: m.BannerContent })),
  },
});

/** @public */
export const box1HomePlugin = createFrontendPlugin({
  pluginId: 'box1-home',
  extensions: [box1OperationsBanner],
});

export default box1HomePlugin;
