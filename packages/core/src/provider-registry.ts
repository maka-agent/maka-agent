import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from './model-metadata.generated.js';
import type { ProviderDefaults } from './llm-connections.js';

const siliconflow = GENERATED_MODELS_DEV_PROVIDER_FACTS.siliconflow;
if (!siliconflow.api) throw new Error('models.dev SiliconFlow provider facts are missing api');
const SILICONFLOW_RECOMMENDED_MODEL_IDS = ['moonshotai/Kimi-K2.6'];

const siliconflowModelEntries = Object.entries(GENERATED_MODELS_DEV_METADATA.siliconflow);
const siliconflowModelsById = new Map(siliconflowModelEntries);
const orderedSiliconflowModels = [
  ...SILICONFLOW_RECOMMENDED_MODEL_IDS.map((id) => {
    const model = siliconflowModelsById.get(id);
    if (!model) throw new Error(`models.dev SiliconFlow snapshot is missing recommended model ${id}`);
    return [id, model] as const;
  }),
  ...siliconflowModelEntries.filter(([id]) => !SILICONFLOW_RECOMMENDED_MODEL_IDS.includes(id)),
];

const siliconflowModelIds = orderedSiliconflowModels
  .filter(([, model]) => model.capabilities?.functionCalling)
  .map(([id]) => id);

export const SILICONFLOW_PROVIDER_DEFAULTS: ProviderDefaults = {
  label: siliconflow.name,
  description: 'Hosted multi-model API with exact upstream model ids.',
  baseUrl: siliconflow.api,
  authKind: 'api_key',
  backendKind: 'ai-sdk',
  fallbackModels: siliconflowModelIds,
  status: 'ready',
  protocol: 'openai',
  runtimeAdapter: 'openai-compatible',
  category: 'domestic',
  catalogGroup: 'aggregators',
  catalogBadge: 'Aggregator',
  signupUrl: siliconflow.doc,
  modelsDevId: siliconflow.id,
};
