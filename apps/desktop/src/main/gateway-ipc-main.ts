import { ipcMain } from 'electron';
import type { OpenGatewayService } from './open-gateway.js';

export interface GatewayIpcDeps {
  openGateway: OpenGatewayService;
}

export function registerGatewayIpc(deps: GatewayIpcDeps): void {
  ipcMain.handle('gateway:status', async () => deps.openGateway.getStatus());
}
