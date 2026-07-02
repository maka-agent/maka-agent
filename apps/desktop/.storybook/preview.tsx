import type { Decorator, Preview } from '@storybook/react-vite';
import '../src/renderer/styles.css';
import { THEME_PALETTES } from '../../../packages/core/src/settings.js';

const PALETTE_LABELS: Record<string, string> = {
  default: 'Default',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'tokyo-night': 'Tokyo Night',
};

const withMakaRoot: Decorator = (Story, context) => {
  const root = document.documentElement;
  const colorScheme = context.globals.colorScheme === 'dark' ? 'dark' : 'light';
  const palette = typeof context.globals.palette === 'string' ? context.globals.palette : 'default';

  root.classList.toggle('dark', colorScheme === 'dark');
  root.style.colorScheme = colorScheme;
  root.setAttribute('lang', 'zh');

  if (palette === 'default') {
    root.removeAttribute('data-maka-theme');
  } else {
    root.setAttribute('data-maka-theme', palette);
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground antialiased">
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withMakaRoot],
  globalTypes: {
    colorScheme: {
      description: 'Renderer color scheme',
      toolbar: {
        icon: 'mirror',
        items: [
          { title: 'Light', value: 'light' },
          { title: 'Dark', value: 'dark' },
        ],
      },
    },
    palette: {
      description: 'Maka palette token set',
      toolbar: {
        icon: 'paintbrush',
        items: THEME_PALETTES.map((palette) => ({
          title: PALETTE_LABELS[palette] ?? palette.replace(/(^|-)(\w)/g, (_, p1, p2) => (p1 ? p2.toUpperCase() : p2)),
          value: palette,
        })),
      },
    },
  },
  initialGlobals: {
    colorScheme: 'light',
    palette: 'default',
  },
  parameters: {
    backgrounds: {
      disable: true,
    },
    controls: {
      expanded: true,
    },
  },
};

export default preview;
