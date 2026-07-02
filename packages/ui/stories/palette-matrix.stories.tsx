import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { THEME_PALETTES } from '../../../packages/core/src/settings.js';

const meta = {
  title: 'Design System/Palette Matrix',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function useIsDark() {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDark(el.classList.contains('dark'));
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

const paletteTokens = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['accent', '--accent'],
  ['info', '--info'],
  ['success', '--success'],
  ['destructive', '--destructive'],
] as const;

export const AllPalettes: Story = {
  render: () => {
    const isDark = useIsDark();
    return (
      <section style={{ display: 'grid', gap: 20, maxWidth: 920 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Palette Matrix</h2>
          <p style={{ color: 'var(--foreground-60)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            {THEME_PALETTES.length} 个 palette,用工具栏切 light/dark 查看另一组。每个块独立应用 data-maka-theme。
          </p>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}
        >
          {THEME_PALETTES.map((palette) => (
            <div
              key={palette}
              data-maka-theme={palette === 'default' ? undefined : palette}
              className={isDark ? 'dark' : undefined}
              style={{
                display: 'grid',
                gap: 8,
                padding: 12,
                borderRadius: 'var(--radius-surface)',
                boxShadow: 'var(--shadow-minimal-flat)',
                background: 'var(--background)',
                color: 'var(--foreground)',
              }}
            >
              <strong style={{ fontSize: 13, fontWeight: 650 }}>{palette}</strong>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {paletteTokens.map(([name, token]) => (
                  <div key={token} style={{ display: 'grid', gap: 3, placeItems: 'center' }}>
                    <div
                      style={{
                        background: `var(${token})`,
                        borderRadius: 'var(--radius-control)',
                        boxShadow: 'inset 0 0 0 1px var(--border)',
                        height: 28,
                        width: 28,
                      }}
                      title={`${name}: ${token}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  },
};
