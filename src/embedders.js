import { LocalEmbedder } from './core.js';

const DEFAULT_MINILM_MODEL = 'Xenova/all-MiniLM-L6-v2';

export function normalizeEmbedderConfig(raw) {
  if (raw == null || raw === '') {
    return { type: 'local' };
  }
  if (typeof raw === 'string') {
    return { type: raw };
  }
  if (typeof raw === 'object' && raw.type) {
    if (raw.type === 'minilm' && !raw.model) {
      return { ...raw, model: DEFAULT_MINILM_MODEL };
    }
    return raw;
  }
  return { type: 'local' };
}

export function embedderSignature(embedder) {
  return `${embedder.name}:${embedder.model || 'none'}:${embedder.dim}`;
}

export async function createEmbedder(config, { importModule = (m) => import(m) } = {}) {
  const normalized = normalizeEmbedderConfig(config?.embedder);

  if (normalized.type === 'minilm') {
    try {
      const model = normalized.model || DEFAULT_MINILM_MODEL;
      const { pipeline } = await importModule('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', model);
      const probe = await extractor('probe', { pooling: 'mean', normalize: true });
      const dim = probe?.data?.length ?? probe?.dims?.[1];
      if (!dim) {
        throw new Error('Could not determine embedding dimension from model probe');
      }

      return {
        name: 'minilm',
        model,
        dim,
        async embed(text) {
          const input = String(text || '').trim();
          if (!input) return new Array(dim).fill(0);
          const output = await extractor(input, { pooling: 'mean', normalize: true });
          return Array.from(output.data);
        }
      };
    } catch (error) {
      console.warn(
        `MiniLM embedder unavailable (${error.message}). Falling back to local hash embedder. Install with: npm i @xenova/transformers`
      );
    }
  }

  const local = new LocalEmbedder();
  return {
    name: local.name,
    model: local.model,
    dim: local.dim,
    embed: (text) => local.embed(text)
  };
}
