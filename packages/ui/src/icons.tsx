/**
 * Centralized icon re-export — the single seam between Maka call sites
 * and the underlying generic UI icon library.
 *
 * Business code imports icons from `@maka/ui/icons`; this file decides
 * which icon set backs those names. Generic UI icons now come directly
 * from `lucide-react`. Bot/channel brand icons render from vendored SVG
 * bodies via `BotBrandIcon`.
 */

import type { ReactNode, SVGProps } from 'react';
import {
  MAKA_BOT_ICON_BODIES,
  MAKA_BOT_ICON_PREFIX,
} from './bot-brand-icons.js';

export interface BotBrandIconProps extends Omit<SVGProps<SVGSVGElement>, 'dangerouslySetInnerHTML'> {
  iconId: string;
  fallback?: ReactNode;
}

export function BotBrandIcon({ iconId, fallback = null, width = '1em', height = '1em', ...props }: BotBrandIconProps): ReactNode {
  const prefix = `${MAKA_BOT_ICON_PREFIX}:`;
  const name = iconId.startsWith(prefix) ? iconId.slice(prefix.length) : '';
  const icon = MAKA_BOT_ICON_BODIES[name];
  if (!icon) return fallback;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`${icon.left ?? 0} ${icon.top ?? 0} ${icon.width ?? 24} ${icon.height ?? 24}`}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: icon.body }}
      {...props}
    />
  );
}

export type { LucideIcon, LucideProps } from 'lucide-react';

export {
  Accessibility,
  Activity,
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Brain,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleCheckBig,
  CircleGauge,
  Clipboard,
  Clock,
  Copy,
  CornerDownLeft,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  FileCode,
  FileEdit,
  FileImage,
  FileText,
  FileType,
  Flag,
  FolderOpen,
  GitBranch,
  GitMerge,
  Globe,
  Grid3X3,
  HelpCircle,
  Hourglass,
  Info,
  KeyRound,
  Keyboard,
  LineChart,
  Loader2,
  Loader2Icon,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  Monitor,
  Moon,
  MoreHorizontal,
  MoreHorizontalIcon,
  MousePointer2,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftIcon,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  RefreshCcw,
  Repeat,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  SearchIcon,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sun,
  SunMoon,
  Terminal,
  Trash2,
  User,
  Volume2,
  Wifi,
  X,
  XIcon,
} from 'lucide-react';
