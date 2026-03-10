/**
 * useSettings — Fleet-level defaults with per-node overrides.
 *
 * Single source of truth for:
 *   - Electricity rate ($/kWh) — affects Cost/1k tokens, Idle Fleet Cost
 *   - Currency code — display only (no FX conversion)
 *   - PUE multiplier — affects computeWES for every node
 *
 * Persisted to localStorage under "wicklee_settings".
 * Migrates old "wk_node_pue" data on first mount.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

// ── Currency catalogue ────────────────────────────────────────────────────────

export const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar',          symbol: '$'  },
  { value: 'EUR', label: 'EUR — Euro',                symbol: '€'  },
  { value: 'GBP', label: 'GBP — British Pound',       symbol: '£'  },
  { value: 'AUD', label: 'AUD — Australian Dollar',   symbol: 'A$' },
  { value: 'CAD', label: 'CAD — Canadian Dollar',     symbol: 'C$' },
  { value: 'JPY', label: 'JPY — Japanese Yen',        symbol: '¥'  },
  { value: 'NGN', label: 'NGN — Nigerian Naira',      symbol: '₦'  },
  { value: 'IDR', label: 'IDR — Indonesian Rupiah',   symbol: 'Rp' },
  { value: 'BRL', label: 'BRL — Brazilian Real',      symbol: 'R$' },
] as const;

export type CurrencyCode = typeof CURRENCY_OPTIONS[number]['value'];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FleetSettings {
  kwhRate: number;
  currency: CurrencyCode;
  pue: number;
}

export interface NodeOverride {
  kwhRate?: number;
  currency?: CurrencyCode;
  pue?: number;
  locationLabel?: string;
}

export interface WickleeSettings {
  fleet: FleetSettings;
  nodes: Record<string, NodeOverride>;
}

/** Resolved values for a specific node — override ?? fleet default, plus override flags. */
export interface NodeEffectiveSettings {
  kwhRate: number;
  currency: CurrencyCode;
  pue: number;
  locationLabel: string;
  kwhRateOverride: boolean;
  currencyOverride: boolean;
  pueOverride: boolean;
  hasAnyOverride: boolean;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const FLEET_DEFAULTS: FleetSettings = {
  kwhRate: 0.12,
  currency: 'USD',
  pue: 1.0,
};

// ── Storage helpers ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'wicklee_settings';

function parseSettings(raw: string | null): WickleeSettings {
  try {
    if (!raw) return { fleet: { ...FLEET_DEFAULTS }, nodes: {} };
    const p = JSON.parse(raw) as Partial<WickleeSettings>;
    return {
      fleet: { ...FLEET_DEFAULTS, ...(p.fleet ?? {}) },
      nodes: p.nodes ?? {},
    };
  } catch {
    return { fleet: { ...FLEET_DEFAULTS }, nodes: {} };
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSettings() {
  const [settings, setSettings] = useState<WickleeSettings>(() =>
    parseSettings(localStorage.getItem(STORAGE_KEY))
  );
  const [savedToast, setSavedToast] = useState(false);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Migrate old wk_node_pue → wicklee_settings.nodes[id].pue
  useEffect(() => {
    try {
      const old = localStorage.getItem('wk_node_pue');
      if (!old) return;
      const parsed = JSON.parse(old) as Record<string, number>;
      setSettings(prev => {
        const nodes = { ...prev.nodes };
        Object.entries(parsed).forEach(([id, pue]) => {
          if (pue !== 1.0) nodes[id] = { ...nodes[id], pue };
        });
        const next = { ...prev, nodes };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      localStorage.removeItem('wk_node_pue');
    } catch { /* ignore */ }
  }, []);

  const showToast = useCallback(() => {
    setSavedToast(true);
    if (toastRef.current) clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setSavedToast(false), 1800);
  }, []);

  const persist = useCallback((next: WickleeSettings): WickleeSettings => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    showToast();
    return next;
  }, [showToast]);

  const updateFleet = useCallback((patch: Partial<FleetSettings>) => {
    setSettings(prev => persist({ ...prev, fleet: { ...prev.fleet, ...patch } }));
  }, [persist]);

  const setNodeOverride = useCallback((nodeId: string, patch: Partial<NodeOverride>) => {
    setSettings(prev => {
      const curr: NodeOverride = { ...(prev.nodes[nodeId] ?? {}) };
      (Object.keys(patch) as (keyof NodeOverride)[]).forEach(k => {
        const v = patch[k];
        if (v === undefined || v === '') delete curr[k];
        else (curr as Record<string, unknown>)[k] = v;
      });
      const nodes = { ...prev.nodes };
      if (Object.keys(curr).length === 0) delete nodes[nodeId];
      else nodes[nodeId] = curr;
      return persist({ ...prev, nodes });
    });
  }, [persist]);

  const clearAllOverridesForField = useCallback(
    (field: 'kwhRate' | 'currency' | 'pue') => {
      setSettings(prev => {
        const nodes = { ...prev.nodes };
        Object.keys(nodes).forEach(id => {
          const curr = { ...nodes[id] };
          delete curr[field];
          if (Object.keys(curr).length === 0) delete nodes[id];
          else nodes[id] = curr;
        });
        return persist({ ...prev, nodes });
      });
    },
    [persist],
  );

  const getNodeSettings = useCallback(
    (nodeId: string): NodeEffectiveSettings => {
      const ov = settings.nodes[nodeId] ?? {};
      const fl = settings.fleet;
      const kwhRate         = ov.kwhRate  ?? fl.kwhRate;
      const currency        = ov.currency ?? fl.currency;
      const pue             = ov.pue      ?? fl.pue;
      const kwhRateOverride  = ov.kwhRate  != null && ov.kwhRate  !== fl.kwhRate;
      const currencyOverride = ov.currency != null && ov.currency !== fl.currency;
      const pueOverride      = ov.pue      != null && ov.pue      !== fl.pue;
      return {
        kwhRate, currency, pue,
        locationLabel: ov.locationLabel ?? '',
        kwhRateOverride, currencyOverride, pueOverride,
        hasAnyOverride: kwhRateOverride || currencyOverride || pueOverride,
      };
    },
    [settings],
  );

  return {
    settings,
    savedToast,
    getNodeSettings,
    updateFleet,
    setNodeOverride,
    clearAllOverridesForField,
  };
}
