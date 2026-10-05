import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Database, Key, RefreshCw } from "lucide-react";
import Card from "./Card";
import Button from "./Button";

const LOCALHOST_URL = /^[a-z][\w+.-]*:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i;

function isFilled(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function VariableInput({ name, value, disabled, onChange, placeholder }) {
  return (
    <>
      <input
        type="password"
        autoComplete="new-password"
        aria-label={`${name} value`}
        placeholder={placeholder || `Enter ${name}...`}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-1.5 text-xs text-[#362217] placeholder-[#A39284] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] font-mono shadow-2xs disabled:bg-[#FAF8F5] disabled:text-[#A39284]"
      />
      {LOCALHOST_URL.test(String(value || "").trim()) && (
        <p className="mt-1 text-[10px] text-amber-700">
          Points to localhost, which on AWS is the container itself. Use a hosted address instead.
        </p>
      )}
    </>
  );
}

/**
 * Environment variables detected from the repository source: required ones block deployment
 * until set (or marked "not needed"), optional ones have defaults, services need hosted instances.
 */
export default function EnvironmentWizard({ project, envValues, setEnvValues, onSave, saving, onScan, scanning, providedKeys = [] }) {
  const analysis = project?.envAnalysis;
  const [ignored, setIgnored] = useState(() => new Set(analysis?.ignored || []));

  const { required, optional } = useMemo(() => {
    const variables = Array.isArray(analysis?.variables)
      ? analysis.variables
      : (project?.requiredEnv || []).map((name) => ({ name, required: true, locations: [] }));
    return {
      required: variables.filter((variable) => variable.required),
      optional: variables.filter((variable) => !variable.required),
    };
  }, [analysis, project?.requiredEnv]);
  const services = Array.isArray(analysis?.services) ? analysis.services : [];
  // Variables the SkyForge-managed database sets for the app.
  const provided = new Set(providedKeys);
  const missing = required.filter((variable) => !ignored.has(variable.name) && !provided.has(variable.name) && !isFilled(envValues[variable.name]));

  const setValue = (name, value) => setEnvValues({ ...envValues, [name]: value });
  const toggleIgnored = (name) => {
    const next = new Set(ignored);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setIgnored(next);
  };

  return (
    <Card glow={false} className="flex flex-col gap-4 bg-white border border-[#EAE1D5]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EADFCF] pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-[#9E5D2D]/10 text-[#9E5D2D]">
            <Key className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[#362217]">Environment Variables</h3>
            <p className="text-xs text-[#5E4C3E]">
              {analysis
                ? `Detected from ${analysis.scannedFiles || "the"} source files. Required values block deployment until set.`
                : "Scanning the repository source for the variables this app reads..."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-semibold ${missing.length ? "text-amber-700" : "text-[#2E6B4F]"}`}>
            {required.length ? (missing.length ? `${missing.length} of ${required.length} required missing` : "All required set") : "None required"}
          </span>
          <Button variant="outline" size="sm" icon={RefreshCw} loading={scanning} onClick={onScan}>
            Re-scan
          </Button>
        </div>
      </div>

      {services.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <span className="flex items-center gap-2 text-xs font-bold text-amber-800">
            <Database className="h-4 w-4" /> This app needs backing services
          </span>
          <ul className="flex flex-col gap-1.5 text-[11px] text-[#5E4C3E]">
            {services.map((service) => (
              <li key={service.id}>
                <strong>{service.label}</strong>
                <span className="text-[#8C7667]"> (from {service.evidence?.join(", ")})</span>
                {service.id === "sqlite"
                  ? ": works, but data lives inside the container and resets on every deployment."
                  : `: SkyForge does not create it. Use a hosted instance reachable from AWS and set ${service.envVars?.length ? service.envVars.join(", ") : service.envHint || "its connection string"}.`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave([...ignored]);
        }}
        className="flex flex-col gap-4"
      >
        {required.length > 0 ? (
          <div className="rounded-2xl border border-[#EAE1D5] overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs border-collapse">
              <thead>
                <tr className="bg-[#FAF8F5] border-b border-[#EAE1D5] text-[#8C7667] font-bold">
                  <th className="p-3 w-1/3">Required variable</th>
                  <th className="p-3 w-28">Status</th>
                  <th className="p-3">Value</th>
                  <th className="p-3 w-24 text-center">Not needed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EAE1D5]">
                {required.map((variable) => {
                  const skipped = ignored.has(variable.name);
                  const auto = provided.has(variable.name);
                  const configured = auto || isFilled(envValues[variable.name]);
                  return (
                    <tr key={variable.name} className={skipped ? "opacity-60" : "hover:bg-[#FAF8F5]/60 transition"}>
                      <td className="p-3 align-top">
                        <div className="font-mono font-bold text-[#362217] break-all">{variable.name}</div>
                        {variable.locations?.length > 0 && (
                          <div className="mt-0.5 font-mono text-[10px] text-[#8C7667] break-all">
                            used in {variable.locations.join(", ")}
                          </div>
                        )}
                      </td>
                      <td className="p-3 align-top">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                            skipped
                              ? "bg-[#FAF8F5] text-[#8C7667] border-[#EAE1D5]"
                              : configured
                                ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/20"
                                : "bg-amber-500/10 text-amber-700 border-amber-500/20"
                          }`}
                        >
                          {skipped ? "Skipped" : auto ? <><CheckCircle2 className="h-3 w-3" /> Automatic</> : configured ? <><CheckCircle2 className="h-3 w-3" /> Set</> : <><AlertCircle className="h-3 w-3" /> Missing</>}
                        </span>
                      </td>
                      <td className="p-3 align-top">
                        {auto ? (
                          <span className="text-[11px] text-[#2E6B4F]">Set automatically by the SkyForge-managed database</span>
                        ) : (
                          <VariableInput name={variable.name} value={envValues[variable.name]} disabled={skipped} onChange={(value) => setValue(variable.name, value)} />
                        )}
                      </td>
                      <td className="p-3 align-top text-center">
                        <input
                          type="checkbox"
                          aria-label={`${variable.name} is not needed`}
                          checked={skipped}
                          onChange={() => toggleIgnored(variable.name)}
                          className="h-4 w-4 accent-[#9E5D2D]"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5 rounded-2xl bg-[#FAF8F5] text-center text-xs text-[#8C7667]">
            {analysis ? "No required environment variables were found in the source." : "Waiting for the repository scan..."}
          </div>
        )}

        {optional.length > 0 && (
          <details className="rounded-2xl border border-[#EAE1D5]">
            <summary className="cursor-pointer select-none p-3 text-xs font-bold text-[#5E4C3E]">
              Optional variables ({optional.length}): have defaults or are build-time settings
            </summary>
            <div className="divide-y divide-[#EAE1D5] border-t border-[#EAE1D5]">
              {optional.map((variable) => (
                <div key={variable.name} className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-[1fr_1.4fr] sm:items-start">
                  <div>
                    <div className="font-mono text-xs font-bold text-[#362217] break-all">
                      {variable.name}
                      {variable.buildTime && (
                        <span className="ml-2 rounded bg-[#3B7A75]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#3B7A75]">BUILD-TIME</span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-[#8C7667] break-all">
                      {variable.exampleValue ? `example: ${variable.exampleValue}` : variable.locations?.length ? `used in ${variable.locations.join(", ")}` : "has a default in code"}
                    </div>
                  </div>
                  <VariableInput
                    name={variable.name}
                    value={envValues[variable.name]}
                    onChange={(value) => setValue(variable.name, value)}
                    placeholder="Leave empty to use the default"
                  />
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-[#8C7667]">
            {missing.length > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
            {missing.length > 0
              ? "Deployment is blocked until every required variable is set or marked not needed."
              : "Values are encrypted and injected into the container as secrets."}
          </span>
          <Button type="submit" size="sm" icon={Check} loading={saving}>
            Save Environment Variables
          </Button>
        </div>
      </form>
    </Card>
  );
}
