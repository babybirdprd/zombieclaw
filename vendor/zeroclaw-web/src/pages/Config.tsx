import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Save,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import type { ProviderConfigEntry, ProviderPreset } from '@/types/api';
import { getConfig, getProviderConfig, putConfig, saveProviderConfig } from '@/lib/api';

export default function Config() {
  const [config, setConfig] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [providerConfigPath, setProviderConfigPath] = useState('');
  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([]);
  const [providerEntries, setProviderEntries] = useState<ProviderConfigEntry[]>([]);

  const [selectedPreset, setSelectedPreset] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [apiFamily, setApiFamily] = useState('openai-completions');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const selectedPresetDetails = useMemo(
    () => providerPresets.find((preset) => preset.id === selectedPreset) ?? null,
    [providerPresets, selectedPreset],
  );

  const reloadProviderConfig = async (): Promise<void> => {
    const providerPayload = await getProviderConfig();
    setProviderConfigPath(providerPayload.path);
    setProviderPresets(providerPayload.presets);
    setProviderEntries(providerPayload.providers);
  };

  useEffect(() => {
    Promise.all([getConfig(), getProviderConfig()])
      .then(([configText, providerPayload]) => {
        setConfig(typeof configText === 'string' ? configText : JSON.stringify(configText, null, 2));
        setProviderConfigPath(providerPayload.path);
        setProviderPresets(providerPayload.presets);
        setProviderEntries(providerPayload.providers);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load configuration');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSaveToml = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await putConfig(config);
      setSuccess('TOML configuration saved successfully.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save TOML configuration');
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (presetId: string) => {
    setSelectedPreset(presetId);
    const preset = providerPresets.find((row) => row.id === presetId);
    if (!preset) return;
    setProviderId(preset.providerId);
    setModelId(preset.modelId);
    setApiFamily(preset.api);
    setBaseUrl(preset.baseUrl);
  };

  const handleSaveProvider = async () => {
    const trimmedProviderId = providerId.trim().toLowerCase();
    const trimmedModelId = modelId.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();

    if (!trimmedProviderId) {
      setError('Provider ID is required.');
      return;
    }

    setSavingProvider(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await saveProviderConfig({
        providerId: trimmedProviderId,
        modelId: trimmedModelId || undefined,
        api: apiFamily.trim() || undefined,
        baseUrl: trimmedBaseUrl || undefined,
        apiKey: trimmedApiKey || undefined,
      });
      await reloadProviderConfig();
      setApiKey('');
      if (result.warning) {
        setSuccess(`Provider saved, but activation warning: ${result.warning}`);
      } else {
        setSuccess(`Provider settings saved and runtime reloaded (${result.providerId}).`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save provider configuration');
    } finally {
      setSavingProvider(false);
    }
  };

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(timer);
  }, [success]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-blue-400" />
          <h2 className="text-base font-semibold text-white">Configuration</h2>
        </div>
        <button
          onClick={handleSaveToml}
          disabled={saving}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save TOML'}
        </button>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-blue-300" />
          <h3 className="text-sm font-semibold text-white">Provider Quick Setup</h3>
        </div>
        <p className="text-xs text-gray-400">
          This writes Pi&apos;s <code>models.json</code> and reloads the runtime immediately.
        </p>
        <p className="text-xs text-gray-500 break-all">
          Path: {providerConfigPath || '(unavailable)'}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-gray-400">Preset</span>
            <select
              value={selectedPreset}
              onChange={(e) => applyPreset(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Manual</option>
              {providerPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs text-gray-400">Provider ID</span>
            <input
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              placeholder="nvidia"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs text-gray-400">Model ID</span>
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="meta/llama-3.1-70b-instruct"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs text-gray-400">API Family</span>
            <input
              value={apiFamily}
              onChange={(e) => setApiFamily(e.target.value)}
              placeholder="openai-completions"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="space-y-1 md:col-span-2">
            <span className="text-xs text-gray-400">Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://integrate.api.nvidia.com/v1"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>

          <label className="space-y-1 md:col-span-2">
            <span className="text-xs text-gray-400">
              API Key {selectedPresetDetails ? `(${selectedPresetDetails.apiKeyEnv})` : ''}
            </span>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="Paste key to update"
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
        </div>

        {selectedPresetDetails && (
          <p className="text-xs text-gray-400">
            {selectedPresetDetails.description}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleSaveProvider}
            disabled={savingProvider}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {savingProvider ? 'Applying...' : 'Save Provider + Reload Runtime'}
          </button>
        </div>
      </div>

      {providerEntries.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 bg-gray-800/40">
            <p className="text-sm text-white font-medium">Configured Providers</p>
          </div>
          <div className="divide-y divide-gray-800">
            {providerEntries.map((entry) => (
              <div key={entry.providerId} className="px-4 py-3 text-sm">
                <p className="text-white font-medium">{entry.providerId}</p>
                <p className="text-gray-400 mt-1">
                  API: {entry.api ?? 'default'} · Base URL: {entry.baseUrl ?? 'default'}
                </p>
                <p className="text-gray-500 mt-1">
                  Models: {entry.models.length > 0 ? entry.models.join(', ') : 'default'} · Key: {entry.apiKeyMasked ?? '(not stored here)'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-4">
        <ShieldAlert className="h-5 w-5 text-yellow-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-yellow-300 font-medium">
            Sensitive fields are masked in list views
          </p>
          <p className="text-sm text-yellow-400/70 mt-0.5">
            When updating a key, paste a full new value. Existing stored keys are never returned in plain text.
          </p>
        </div>
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-900/30 border border-green-700 rounded-lg p-3">
          <CheckCircle className="h-4 w-4 text-green-400 flex-shrink-0" />
          <span className="text-sm text-green-300">{success}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-700 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0" />
          <span className="text-sm text-red-300">{error}</span>
        </div>
      )}

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-800/50">
          <span className="text-xs text-gray-400 font-medium uppercase tracking-wider">
            TOML Compatibility Config
          </span>
          <span className="text-xs text-gray-500">
            {config.split('\n').length} lines
          </span>
        </div>
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          spellCheck={false}
          className="w-full min-h-[480px] bg-gray-950 text-gray-200 font-mono text-sm p-4 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset"
          style={{ tabSize: 4 }}
        />
      </div>
    </div>
  );
}
