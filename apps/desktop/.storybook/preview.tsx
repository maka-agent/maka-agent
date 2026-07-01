import type { Decorator, Preview } from '@storybook/react-vite';
import '../src/renderer/styles.css';

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
        items: [
          { title: 'Default', value: 'default' },
          { title: 'Onedark', value: 'onedark' },
          { title: 'Azure', value: 'azure' },
          { title: 'Forest', value: 'forest' },
        ],
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
