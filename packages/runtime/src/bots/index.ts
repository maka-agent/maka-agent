export {
  BaseBotAdapter,
  botReadinessFromSettings,
  botSettingsRequireRestart,
} from './base-adapter.js';
export { BotRegistry } from './bot-registry.js';
export { testBotChannel } from './bot-test.js';
export { proxiedFetch } from './proxied-fetch.js';
export {
  getWechatBridgeQrCode,
  mapWechatIlinkMessage,
  normalizeWechatBridgeUrl,
  normalizeWechatIlinkBaseUrl,
  testWechatBridge,
  testWechatIlinkCredentials,
  WechatBridge,
} from './wechat-bridge.js';
export type { WechatBridgeQrCodeResult } from './wechat-bridge.js';
export type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotStatus,
  BotTestResult,
  SendCapable,
} from './types.js';
