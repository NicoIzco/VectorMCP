import { DEFAULT_CONFIG } from './core.js';

export async function fetchRegistry(registryUrl = DEFAULT_CONFIG.registryUrl) {
  try {
    const res = await fetch(registryUrl, {
      headers: { accept: 'application/json' }
    });

    if (!res.ok) {
      throw new Error(`Registry request failed with status ${res.status}`);
    }

    const payload = await res.json();
    if (!Array.isArray(payload)) {
      throw new Error('Registry format is invalid: expected a JSON array');
    }

    return payload;
  } catch (error) {
    throw new Error(`Registry unreachable: ${error.message}`);
  }
}

export async function searchRegistry(query, registryUrl = DEFAULT_CONFIG.registryUrl) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [];

  const registry = await fetchRegistry(registryUrl);
  return registry.filter((skill) => {
    const fields = [
      skill.name,
      skill.description,
      ...(Array.isArray(skill.tags) ? skill.tags : [])
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return fields.some((value) => value.includes(normalizedQuery));
  });
}

export async function resolveSkill(name, registryUrl = DEFAULT_CONFIG.registryUrl) {
  const registry = await fetchRegistry(registryUrl);
  const entry = registry.find((skill) => String(skill.name || '').toLowerCase() === String(name || '').toLowerCase());

  if (!entry) {
    throw new Error(`Skill not found in registry: ${name}`);
  }

  if (!entry.repo) {
    throw new Error(`Skill entry is missing repo URL: ${name}`);
  }

  return entry.repo;
}
