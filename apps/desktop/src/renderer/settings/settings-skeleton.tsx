type SkeletonLine = { width: string; size?: 'lg' | 'sm' };

// 权限/健康快照页共用的骨架行预设：首行大号标题条，其余模拟段落行宽。
const SNAPSHOT_SKELETON_LINES: ReadonlyArray<SkeletonLine> = [
  { width: '38%', size: 'lg' },
  { width: '72%' },
  { width: '60%' },
  { width: '80%' },
];

// 带可访问性 label 的骨架行堆，供各设置页加载态共用，避免每页手写重复的 skeleton 标记。
export function SettingsSkeletonStack({
  label,
  lines = SNAPSHOT_SKELETON_LINES,
}: {
  label: string;
  lines?: ReadonlyArray<SkeletonLine>;
}) {
  return (
    <div className="maka-skeleton-stack" aria-busy="true" aria-label={label}>
      {lines.map((line, index) => (
        <div
          key={index}
          className="maka-skeleton maka-skeleton-line"
          data-size={line.size}
          style={{ width: line.width }}
        />
      ))}
    </div>
  );
}

export function SettingsSkeleton() {
  const copy = getSettingsSharedCopy(useUiLocale());
  return (
    <div className="settingsLoadingSkeleton" aria-busy="true" aria-label={copy.loading}>
      <div className="maka-skeleton-stack">
        <div className="maka-skeleton maka-skeleton-line" data-size="lg" style={{ width: '38%' }} />
        <div className="maka-skeleton maka-skeleton-card" />
        <div className="maka-skeleton maka-skeleton-line" data-size="sm" style={{ width: '60%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '85%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '72%' }} />
        <div className="maka-skeleton maka-skeleton-line" style={{ width: '48%' }} />
      </div>
    </div>
  );
}
import { useUiLocale } from '@maka/ui';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
