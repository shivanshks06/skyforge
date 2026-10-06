import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import {
  Rocket,
  Terminal,
  Activity,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Globe,
  ShieldCheck,
  Key,
  RotateCcw,
  Undo2,
  AlertCircle,
  Trash2,
  Flame,
  Lock,
  Eye,
  EyeOff,
  X,
  GitBranch,
  GitCommitHorizontal,
  Zap,
  Settings2,
  Loader2,
  Lightbulb,
  ArrowRight,
  Wand2,
  Search,
  Download,
  ArrowDownToLine,
  History,
} from "lucide-react";
import Button from "../components/Button";
import {
  getProjectById,
  triggerProjectDeployment,
  retryDeployment,
  rollbackDeployment,
  getDeploymentQueuePosition,
  getDeploymentById,
  getProjectDeployments,
  getAwsStatus,
  saveAwsCredentials,
  destroyDeployment,
  destroyProjectInfrastructure,
  streamDeploymentLogs,
  getDeploymentDiagnosis,
  restoreDeploymentVersion,
  saveProjectRuntime,
  saveBuildMode,
} from "../services/api";
import StatusBadge from "../components/StatusBadge";
import { stageDurations, stageInfo } from "../utils/stages";
import { buttonClass, formatDuration, timeAgo } from "../utils/format";

const TERMINAL_STATUSES = new Set([
  "LIVE",
  "FAILED",
  "CANCELLED",
  "ROLLED_BACK",
  "DESTROYED",
  "DESTROY_FAILED",
]);
const ACTIVE_STATUSES = new Set([
  "QUEUED",
  "BUILDING",
  "PUSHING",
  "PROVISIONING",
  "DEPLOYING",
  "HEALTH_CHECK",
  "ROLLING_BACK",
  "DESTROYING",
]);

const STAGE_STATUS = {
  CLONING: "BUILDING",
  BUILDING: "BUILDING",
  PUSHING: "PUSHING",
  PROVISIONING: "PROVISIONING",
  DEPLOYING: "DEPLOYING",
  HEALTH_CHECK: "HEALTH_CHECK",
  LIVE: "LIVE",
  COMPLETE: "LIVE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  ROLLBACK: "ROLLING_BACK",
  ROLLBACK_COMPLETE: "ROLLED_BACK",
  ROLLBACK_FAILED: "FAILED",
  DESTROY: "DESTROYING",
  DESTROY_COMPLETE: "DESTROYED",
  DESTROY_FAILED: "DESTROY_FAILED",
};

const STAGES = [
  { id: "CLONING", label: "Download code", desc: "Fetching the branch from GitHub" },
  { id: "BUILDING", label: "Build", desc: "Installing and building the app" },
  { id: "PUSHING", label: "Upload image", desc: "Sending the container to AWS" },
  { id: "PROVISIONING", label: "Set up AWS", desc: "Load balancer, network and service" },
  { id: "DEPLOYING", label: "Roll out", desc: "Starting the new version" },
  { id: "HEALTH_CHECK", label: "Health check", desc: "Making sure it answers" },
  { id: "COMPLETE", label: "Live", desc: "Serving visitors" },
];

const STATUS_LABELS = { LIVE: "Live", ROLLED_BACK: "Live (restored)", FAILED: "Failed", CANCELLED: "Cancelled", DESTROYED: "Removed", DESTROY_FAILED: "Teardown failed", QUEUED: "Queued", ROLLING_BACK: "Restoring" };

const TARGET_LABELS = {
  AWS_ECS_FARGATE: "AWS ECS Fargate",
  AWS_ECS_CLOUDFRONT: "AWS ECS Fargate + CloudFront",
  AWS_S3_CLOUDFRONT: "AWS S3 + CloudFront",
};

export default function DeploymentConsole() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [awsConnected, setAwsConnected] = useState(false);
  const [awsData, setAwsData] = useState(null);
  const [activeDeployment, setActiveDeployment] = useState(null);
  const [logs, setLogs] = useState([]);
  const [deploying, setDeploying] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [showDestroyModal, setShowDestroyModal] = useState(false);
  const [showAwsModal, setShowAwsModal] = useState(false);
  const [awsAccessKeyInput, setAwsAccessKeyInput] = useState("");
  const [awsSecretKeyInput, setAwsSecretKeyInput] = useState("");
  const [awsSessionTokenInput, setAwsSessionTokenInput] = useState("");
  const [awsRegionInput, setAwsRegionInput] = useState("ap-south-1");
  const [showAwsSecret, setShowAwsSecret] = useState(false);
  const [savingAwsKeys, setSavingAwsKeys] = useState(false);
  const [awsModalNotice, setAwsModalNotice] = useState(null);
  const [rollbackReason, setRollbackReason] = useState("Reverting to previous stable revision");
  const [queueInfo, setQueueInfo] = useState({ position: 1, totalWaiting: 1 });
  const [loading, setLoading] = useState(true);
  const [deployError, setDeployError] = useState(null);
  const [deployBlockers, setDeployBlockers] = useState([]);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [versions, setVersions] = useState([]);
  const [restoringId, setRestoringId] = useState(null);
  const [diagnosis, setDiagnosis] = useState({ id: null, data: null });
  const [fixing, setFixing] = useState(null);
  const [logSearch, setLogSearch] = useState("");
  const [logLevel, setLogLevel] = useState("all");
  const [followLogs, setFollowLogs] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const terminalRef = useRef(null);

  const eventSourceRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const pollInFlightRef = useRef(false);

  // Keep the terminal pinned to the newest line unless the person scrolled up to read.
  useEffect(() => {
    if (followLogs && terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [logs, followLogs, logSearch, logLevel]);

  // A ticking clock so the running step's duration counts up.
  const operationActive = ACTIVE_STATUSES.has(activeDeployment?.status);
  useEffect(() => {
    if (!operationActive) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [operationActive]);

  // Plain-English explanation for a failed deployment.
  const failedId = ["FAILED", "DESTROY_FAILED"].includes(activeDeployment?.status) ? activeDeployment.id : null;
  useEffect(() => {
    if (!failedId || diagnosis.id === failedId) return;
    let cancelled = false;
    getDeploymentDiagnosis(failedId)
      .then((result) => !cancelled && setDiagnosis({ id: failedId, data: result.diagnosis }))
      .catch(() => !cancelled && setDiagnosis({ id: failedId, data: null }));
    return () => {
      cancelled = true;
    };
  }, [failedId, diagnosis.id]);
  const diagnosisFor = diagnosis.id && diagnosis.id === activeDeployment?.id ? diagnosis.data : null;

  const loadVersions = () => getProjectDeployments(id).then(setVersions).catch(() => {});

  const stopPolling = () => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
    pollInFlightRef.current = false;
  };

  const settleTerminalState = (status) => {
    if (!TERMINAL_STATUSES.has(status)) return false;
    stopPolling();
    void loadVersions();
    setDeploying(false);
    setRetrying(false);
    setRollingBack(false);
    setDestroying(false);
    return true;
  };

  const startStatusPolling = (deploymentId, interval = 3000) => {
    stopPolling();
    if (!deploymentId) return;
    pollIntervalRef.current = window.setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await pollDeploymentStatus(deploymentId);
      } finally {
        pollInFlightRef.current = false;
      }
    }, interval);
  };

  const loadInitialData = async () => {
    try {
      setLoading(true);
      const [projData, awsStatus, deployments] = await Promise.all([
        getProjectById(id),
        getAwsStatus().catch(() => ({ connected: false })),
        getProjectDeployments(id).catch(() => []),
      ]);

      setProject(projData);
      setVersions(Array.isArray(deployments) ? deployments : []);
      setAwsConnected(awsStatus.connected);
      setAwsData(awsStatus);

      if (deployments && deployments.length > 0) {
        const requestedDeploymentId = searchParams.get("deploymentId");
        const latest = deployments.find((entry) => entry.id === requestedDeploymentId) || deployments[0];
        setActiveDeployment(latest);

        if (latest.status === "QUEUED") {
          fetchQueuePos(latest.id);
        }

        if (TERMINAL_STATUSES.has(latest.status)) {
          const depData = await getDeploymentById(latest.id);
          if (depData?.logs) setLogs(depData.logs);
          if (depData?.deployment) setActiveDeployment(depData.deployment);
          if (["LIVE", "ROLLED_BACK"].includes(latest.status)) startStatusPolling(latest.id, 30_000);
        } else {
          subscribeToLogs(latest.id);
          startStatusPolling(latest.id);
        }
      }
    } catch (err) {
      console.error("Failed to load deployment data:", err);
      setDeployError(err.response?.data?.message || "Unable to load deployment data.");
    } finally {
      setLoading(false);
    }
  };

  const fetchQueuePos = async (deploymentId) => {
    try {
      const res = await getDeploymentQueuePosition(deploymentId);
      setQueueInfo({
        position: Number.isInteger(res?.position) ? res.position : null,
        totalWaiting: Number.isInteger(res?.totalWaiting) ? res.totalWaiting : null,
        status: res?.status || "UNKNOWN",
      });
    } catch {
      // fallback
    }
  };

  const subscribeToLogs = (deploymentId) => {
    eventSourceRef.current?.abort();
    const controller = new AbortController();
    eventSourceRef.current = controller;

    void streamDeploymentLogs(deploymentId, {
      signal: controller.signal,
      onMessage: (data) => {
        setLogs((prev) => prev.some((entry) => entry.id === data.id) ? prev : [...prev, data]);
        const mappedStatus = STAGE_STATUS[data.stage];
        if (mappedStatus) {
          const mappedStage = data.stage === "LIVE" ? "COMPLETE" : data.stage;
          setActiveDeployment((previous) => ({
            ...previous,
            stage: mappedStage,
            currentStep: data.stage,
            status: mappedStatus,
          }));
          if (TERMINAL_STATUSES.has(mappedStatus)) {
            controller.abort();
            window.setTimeout(() => void pollDeploymentStatus(deploymentId), 300);
          }
        }
      },
      onError: (streamError) => {
        if (streamError.name !== "AbortError") {
          console.warn("Deployment log stream ended:", streamError);
          startStatusPolling(deploymentId);
        }
      },
    }).catch((streamError) => {
      if (streamError.name !== "AbortError") {
        console.warn("Deployment log stream ended:", streamError);
        startStatusPolling(deploymentId);
      }
    });
  };

  const pollDeploymentStatus = async (deploymentId) => {
    try {
      const data = await getDeploymentById(deploymentId);
      if (data?.logs?.length) {
        setLogs((previous) => {
          const merged = new Map(previous.map((entry) => [entry.id, entry]));
          for (const entry of data.logs) merged.set(entry.id, entry);
          return [...merged.values()].slice(-1000);
        });
      }
      if (data?.deployment) {
        setActiveDeployment(data.deployment);
        if (data.deployment.error && ["LIVE", "ROLLED_BACK"].includes(data.deployment.status)) {
          setDeployError(data.deployment.error);
        }
        settleTerminalState(data.deployment.status);
        if (data.deployment.status === "QUEUED") await fetchQueuePos(deploymentId);
      }
      const updatedProj = await getProjectById(id);
      setProject(updatedProj);
    } catch (err) {
      console.error("Poll error:", err);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void loadInitialData();
    }, 0);
    return () => {
      window.clearTimeout(task);
      eventSourceRef.current?.abort();
      stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleTriggerDeploy = async () => {
    try {
      setDeploying(true);
      setDeployError(null);
      setDeployBlockers([]);
      setLogs([]);
      const res = await triggerProjectDeployment(id);
      const newDeployment = res.deployment;
      setActiveDeployment(newDeployment);
      subscribeToLogs(newDeployment.id);
      startStatusPolling(newDeployment.id);
      fetchQueuePos(newDeployment.id);
    } catch (err) {
      console.error("Deploy trigger error:", err);
      const blockers = err.response?.data?.blockers || [];
      const msg = err.response?.data?.message || err.message || "Failed to trigger deployment.";
      setDeployError(msg);
      setDeployBlockers(blockers);
      if (blockers.some((b) => /aws|credentials|account/i.test(b))) {
        setShowAwsModal(true);
      }
      setDeploying(false);
    }
  };

  const handleRetryDeploy = async () => {
    if (!activeDeployment) return;
    try {
      setRetrying(true);
      setDeploying(true);
      const res = await retryDeployment(activeDeployment.id);
      const updated = res.deployment || activeDeployment;
      const nextDeploymentId = updated.id;
      setActiveDeployment({
        ...updated,
        status: "QUEUED",
        stage: "CLONING",
      });
      subscribeToLogs(nextDeploymentId);
      startStatusPolling(nextDeploymentId);
      fetchQueuePos(nextDeploymentId);
    } catch (err) {
      console.error("Retry error:", err);
      setDeployError(err.response?.data?.message || "Retry could not be queued.");
      setRetrying(false);
      setDeploying(false);
    }
  };

  const handleRollback = async () => {
    if (!activeDeployment) return;
    try {
      setRollingBack(true);
      setShowRollbackModal(false);
      await rollbackDeployment(activeDeployment.id, rollbackReason);
      setActiveDeployment((prev) => ({
        ...prev,
        status: "ROLLING_BACK",
        stage: "ROLLBACK",
      }));
      subscribeToLogs(activeDeployment.id);
      startStatusPolling(activeDeployment.id);
    } catch (err) {
      console.error("Rollback error:", err);
      setDeployError(err.response?.data?.message || "Rollback could not be queued.");
      setRollingBack(false);
    }
  };

  const handleDestroy = async () => {
    setDestroying(true);
    setDeployError(null);
    setDeployBlockers([]);
    setShowDestroyModal(false);
    try {
      const deploymentId = activeDeployment?.id;
      let targetDepId = deploymentId;

      if (deploymentId && activeDeployment?.status !== "DESTROYED") {
        subscribeToLogs(deploymentId);
        const res = await destroyDeployment(deploymentId);
        if (res?.deploymentId) targetDepId = res.deploymentId;
      } else {
        const res = await destroyProjectInfrastructure(id);
        if (res?.deploymentId) {
          targetDepId = res.deploymentId;
          subscribeToLogs(targetDepId);
        }
      }

      // Optimistically update active deployment to DESTROYING
      setActiveDeployment((prev) => ({
        ...(prev || {}),
        id: targetDepId || prev?.id,
        status: "DESTROYING",
        stage: "DESTROY",
        currentStep: "DESTROY",
      }));

      if (targetDepId) startStatusPolling(targetDepId);
    } catch (err) {
      console.error("Destroy error:", err);
      setDeployError(err.response?.data?.message || "Infrastructure teardown could not be started.");
      setDestroying(false);
    } finally {
      // Safety unlock so button never remains indefinitely stuck in loading state
      window.setTimeout(() => setDestroying(false), 8000);
    }
  };

  const handleRestore = async (version) => {
    if (!window.confirm(`Put the version from ${new Date(version.createdAt).toLocaleString()} back live?`)) return;
    setRestoringId(version.id);
    setDeployError(null);
    try {
      const result = await restoreDeploymentVersion(version.id);
      const servingId = result.deploymentId;
      setLogs([]);
      setActiveDeployment((previous) => ({ ...(previous?.id === servingId ? previous : versions.find((entry) => entry.id === servingId) || previous), id: servingId, status: "ROLLING_BACK", stage: "ROLLBACK" }));
      subscribeToLogs(servingId);
      startStatusPolling(servingId);
    } catch (err) {
      setDeployError(err.response?.data?.message || "That version could not be restored.");
    } finally {
      setRestoringId(null);
    }
  };

  const openDeployment = async (deploymentId) => {
    eventSourceRef.current?.abort();
    stopPolling();
    try {
      const data = await getDeploymentById(deploymentId);
      setActiveDeployment(data.deployment);
      setLogs(data.logs || []);
      navigate(`/project/${id}/deploy?deploymentId=${encodeURIComponent(deploymentId)}`, { replace: true });
      if (ACTIVE_STATUSES.has(data.deployment?.status)) {
        subscribeToLogs(deploymentId);
        startStatusPolling(deploymentId);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setDeployError(err.response?.data?.message || "Could not open that deployment.");
    }
  };

  const handleSaveAwsModalCredentials = async (e) => {
    e.preventDefault();
    if (!awsAccessKeyInput.trim() || !awsSecretKeyInput.trim()) {
      setAwsModalNotice({
        type: "error",
        message: "Please enter both your AWS Access Key ID and Secret Access Key.",
      });
      return;
    }

    setSavingAwsKeys(true);
    setAwsModalNotice(null);
    try {
      const res = await saveAwsCredentials({
        accessKeyId: awsAccessKeyInput.trim(),
        secretAccessKey: awsSecretKeyInput.trim(),
        sessionToken: awsSessionTokenInput.trim() || undefined,
        region: awsRegionInput,
      });
      setAwsConnected(true);
      setAwsData(res);
      setAwsModalNotice({
        type: "success",
        message: `AWS Connected! Account: ${res.accountId || "Active"} (${res.region || awsRegionInput})`,
      });
      setTimeout(() => {
        setShowAwsModal(false);
        setAwsAccessKeyInput("");
        setAwsSecretKeyInput("");
        setAwsSessionTokenInput("");
        setAwsModalNotice(null);
      }, 1000);
    } catch (err) {
      setAwsModalNotice({
        type: "error",
        message: err.response?.data?.message || err.message || "Failed to verify AWS credentials.",
      });
    } finally {
      setSavingAwsKeys(false);
    }
  };

  const handleCopyUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      setDeployError("Clipboard access was denied.");
    }
  };

  const handleCopyAllLogs = async () => {
    const text = logs.map((entry) => `[${entry.timestamp}] [${entry.stage}] ${entry.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLogs(true);
      window.setTimeout(() => setCopiedLogs(false), 2000);
    } catch {
      setDeployError("Clipboard access was denied.");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <RefreshCw className="h-8 w-8 text-[#9E5D2D] animate-spin" />
        <p className="text-sm font-semibold text-[#8C7667]">
          Connecting to BullMQ worker & deployment telemetry...
        </p>
      </div>
    );
  }

  const currentStage = activeDeployment?.stage || (activeDeployment?.status === "LIVE" ? "COMPLETE" : "CLONING");
  const isQueued = activeDeployment?.status === "QUEUED";
  const isActiveOperation = ACTIVE_STATUSES.has(activeDeployment?.status);
  const isDestroyFailed = activeDeployment?.status === "DESTROY_FAILED";
  const isFailed = ["FAILED", "DESTROY_FAILED", "CANCELLED"].includes(activeDeployment?.status);
  const canRetryDeployment = ["FAILED", "CANCELLED"].includes(activeDeployment?.status);
  const isRollingBack = activeDeployment?.status === "ROLLING_BACK";
  const isRolledBack = activeDeployment?.status === "ROLLED_BACK";
  const isDestroying = activeDeployment?.status === "DESTROYING" || destroying;
  const isDestroyed = !isDestroying && activeDeployment?.status === "DESTROYED";
  const isLive = !isDestroyed && !isDestroying && activeDeployment?.status === "LIVE";
  const isBuilding = Boolean(deploying || (!isDestroyed && !isDestroying && ["CLONING", "BUILDING", "PUSHING", "PROVISIONING", "DEPLOYING", "HEALTH_CHECK"].includes(activeDeployment?.status || activeDeployment?.stage)));
  const hasLiveEndpoint = isLive || isRolledBack;
  const liveUrl = activeDeployment?.liveUrl || null;
  const customDomain = project?.customDomain?.status === "ACTIVE" ? `https://${project.customDomain.domain}` : null;
  const healthStatus = activeDeployment?.healthStatus || "UNKNOWN";
  const latency = Number.isInteger(activeDeployment?.latencyMs) ? `${activeDeployment.latencyMs} ms` : "not measured yet";

  const stageIndex = STAGES.findIndex((s) => s.id === currentStage);
  const activeIdx = stageIndex >= 0
    ? stageIndex
    : (isLive || isRolledBack)
      ? STAGES.length - 1
      : (isRollingBack || isDestroying)
        ? STAGES.findIndex((stage) => stage.id === "DEPLOYING")
        : 0;
  const queuePositionLabel = Number.isInteger(queueInfo.position) ? `#${queueInfo.position}` : "starting";

  // Step timings: finished steps from the worker's record, the running step counts up live.
  const timings = Array.isArray(activeDeployment?.stageTimings) ? activeDeployment.stageTimings : [];
  const timingEnd = activeDeployment?.completedAt || (isBuilding || isQueued ? now : null);
  const durationByStage = Object.fromEntries(stageDurations(timings, timingEnd).map((entry) => [entry.stage, entry.ms]));
  const startedAt = activeDeployment?.startedAt || timings[0]?.at || null;
  const elapsed = startedAt ? (activeDeployment?.completedAt ? new Date(activeDeployment.completedAt) : new Date(now)) - new Date(startedAt) : null;
  const progressPercent = hasLiveEndpoint ? 100 : Math.round((Math.max(0, activeIdx) / (STAGES.length - 1)) * 100);

  const statusPill = isDestroyed ? { label: "Removed from AWS", state: "destroyed" }
    : isDestroying ? { label: "Removing from AWS…", state: "working" }
    : isLive ? { label: "Live", state: "live" }
    : isRolledBack ? { label: "Live (restored version)", state: "live" }
    : isFailed ? { label: isDestroyFailed ? "Teardown failed" : activeDeployment?.status === "CANCELLED" ? "Cancelled" : "Failed", state: "failed" }
    : isQueued ? { label: `Queued ${queuePositionLabel}`, state: "working" }
    : isRollingBack ? { label: "Restoring…", state: "working" }
    : isBuilding ? { label: "Deploying…", state: "working" }
    : { label: activeDeployment ? "Ready" : "Not deployed yet", state: "idle" };

  const levelOf = (log) => (log.level === "error" || log.stage === "FAILED" ? "error" : log.level === "warn" || log.stage === "ROLLBACK" ? "warn" : log.level === "success" || log.stage === "LIVE" ? "success" : "info");
  const search = logSearch.trim().toLowerCase();
  const visibleLogs = logs.filter((log) => {
    const level = levelOf(log);
    if (logLevel === "error" && level !== "error") return false;
    if (logLevel === "warn" && !["error", "warn"].includes(level)) return false;
    return !search || String(log.message || "").toLowerCase().includes(search) || String(log.stage || "").toLowerCase().includes(search);
  });
  const errorCount = logs.filter((log) => levelOf(log) === "error").length;
  const restorable = versions.filter((version) => version.restorable);
  const current = versions.find((version) => version.isCurrent);

  const applyFix = async (fix) => {
    setFixing(fix.label);
    try {
      if (fix.kind === "retry") await handleRetryDeploy();
      else if (fix.kind === "link") navigate(fix.to);
      else if (fix.kind === "runtime") {
        await saveProjectRuntime(id, fix.patch);
        setProject(await getProjectById(id));
        if (fix.redeploy) await handleTriggerDeploy();
      } else if (fix.kind === "buildMode") {
        await saveBuildMode(id, fix.mode);
        await handleRetryDeploy();
      }
    } catch (error) {
      setDeployError(error.response?.data?.message || "That fix could not be applied.");
    } finally {
      setFixing(null);
    }
  };

  const downloadLogs = () => {
    const text = logs.map((entry) => `[${entry.timestamp}] [${entry.stage}] ${entry.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${project?.name || "deployment"}-${activeDeployment?.id?.slice(-8) || "logs"}.log` });
    link.click();
    URL.revokeObjectURL(url);
  };

  const highlight = (text) => {
    if (!search) return text;
    const value = String(text);
    const index = value.toLowerCase().indexOf(search);
    if (index < 0) return value;
    return <>{value.slice(0, index)}<mark className="rounded bg-[#FBBF24] px-0.5 text-[#1A1411]">{value.slice(index, index + search.length)}</mark>{value.slice(index + search.length)}</>;
  };

  const primaryAction = isDestroyFailed
    ? { kind: "teardown", label: "Retry teardown", icon: RefreshCw, busy: destroying, danger: true }
    : canRetryDeployment
      ? { kind: "retry", label: "Try again", icon: RotateCcw, busy: retrying }
      : !project?.deploymentTarget
        ? { kind: "target", label: "Choose where to deploy", icon: Rocket }
        : { kind: "deploy", label: hasLiveEndpoint ? "Redeploy" : "Deploy now", icon: Rocket, busy: deploying || isQueued, disabled: isActiveOperation || destroying };
  const PrimaryIcon = primaryAction.icon;
  const primaryKind = primaryAction.kind;
  const runPrimary = () => {
    if (primaryKind === "teardown") return handleDestroy();
    if (primaryKind === "retry") return handleRetryDeploy();
    if (primaryKind === "target") return navigate(`/project/${id}/infrastructure`);
    return handleTriggerDeploy();
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-16">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#8C7667]">
            <Link to="/dashboard/projects" className="transition-colors hover:text-[#362217]">Projects</Link>
            <span>/</span>
            <span className="truncate text-[#362217]">{project?.name || "Project"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="flex items-center gap-2.5 text-2xl font-bold text-[#362217] md:text-3xl">
              <Rocket className="h-7 w-7 text-[#9E5D2D]" />
              {project?.name || "Deployment"}
            </h1>
            <StatusBadge state={statusPill.state} label={statusPill.label} />
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#5E4C3E]">
            <span>{TARGET_LABELS[project?.deploymentTarget] || "No target chosen yet"}</span>
            {project?.branch && <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3.5 w-3.5" /> {project.branch}</span>}
            {activeDeployment?.commitSha && (
              <a href={`https://github.com/${project?.repoName}/commit/${activeDeployment.commitSha}`} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-[#9E5D2D]">
                <GitCommitHorizontal className="h-3.5 w-3.5" />
                <span className="font-mono">{activeDeployment.commitSha.slice(0, 7)}</span>
                <span className="max-w-[18rem] truncate">{activeDeployment.commitMessage?.split("\n")[0]}</span>
              </a>
            )}
            {project?.autoDeploy && <span className="inline-flex items-center gap-1 rounded-full bg-[#2563EB]/10 px-2 py-0.5 text-[10px] font-semibold text-[#1D4ED8]"><Zap className="h-3 w-3" /> Auto-deploy on push</span>}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link to={`/project/${id}/monitor`} className={buttonClass.secondary}><Activity className="h-3.5 w-3.5" /> Monitoring</Link>
          <Link to={`/project/${id}/settings`} className={buttonClass.secondary}><Settings2 className="h-3.5 w-3.5" /> Site settings</Link>
          <Link to={`/project/${id}/security`} className={buttonClass.secondary}><ShieldCheck className="h-3.5 w-3.5" /> Security</Link>
          <button type="button" onClick={() => setShowDestroyModal(true)} disabled={destroying || isBuilding || isRollingBack} className={buttonClass.danger}>
            <Trash2 className="h-3.5 w-3.5" /> Destroy
          </button>
          <button type="button" onClick={runPrimary} disabled={primaryAction.busy || primaryAction.disabled} className={primaryAction.danger ? "inline-flex items-center gap-1.5 rounded-xl bg-[#9E2A2B] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#7E2223] disabled:opacity-60" : buttonClass.primary}>
            {primaryAction.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PrimaryIcon className="h-3.5 w-3.5" />} {primaryAction.label}
          </button>
        </div>
      </div>

      {/* Preflight blockers and request errors */}
      {(deployError || deployBlockers.length > 0) && (
        <div className="page-enter flex flex-col gap-3 rounded-3xl border border-[#9E2A2B]/30 bg-[#9E2A2B]/5 p-5 text-xs text-[#7E2223]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#9E2A2B]" />
              <div>
                <p className="text-sm font-bold">{deployError || "Something needs fixing before this can deploy"}</p>
                {deployBlockers.length > 0 && (
                  <ul className="mt-2 list-inside list-disc space-y-1 font-medium">
                    {deployBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                  </ul>
                )}
              </div>
            </div>
            <button aria-label="Dismiss" onClick={() => { setDeployError(null); setDeployBlockers([]); }} className="rounded-lg p-1 text-[#9E2A2B] transition hover:bg-[#9E2A2B]/15"><X className="h-4 w-4" /></button>
          </div>
          {(deployBlockers.some((b) => /aws|credentials|account/i.test(b)) || deployBlockers.some((b) => /environment variable/i.test(b))) && (
            <div className="flex flex-wrap gap-2 border-t border-[#9E2A2B]/15 pt-3">
              {deployBlockers.some((b) => /aws|credentials|account/i.test(b)) && <button type="button" onClick={() => setShowAwsModal(true)} className={buttonClass.primary}><ShieldCheck className="h-3.5 w-3.5" /> Connect AWS</button>}
              {deployBlockers.some((b) => /environment variable/i.test(b)) && <button type="button" onClick={() => navigate(`/project/${id}/plan`)} className={buttonClass.secondary}>Add environment variables</button>}
            </div>
          )}
        </div>
      )}

      {/* What went wrong, in plain English */}
      {isFailed && activeDeployment?.status !== "CANCELLED" && (
        <div className="page-enter overflow-hidden rounded-3xl border border-[#9E2A2B]/30 bg-white">
          <div className="flex items-start gap-3 border-b border-[#9E2A2B]/15 bg-[#9E2A2B]/5 px-5 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#9E2A2B] text-white"><Lightbulb className="h-4.5 w-4.5 h-[18px] w-[18px]" /></span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#9E2A2B]">What went wrong</p>
              <h3 className="text-base font-bold text-[#362217]">{diagnosisFor?.title || (isDestroyFailed ? "The teardown didn't finish" : "Working out what went wrong…")}</h3>
            </div>
          </div>
          <div className="flex flex-col gap-4 p-5">
            {diagnosisFor ? (
              <>
                <p className="text-sm leading-relaxed text-[#5E4C3E]">{diagnosisFor.explanation}</p>
                {diagnosisFor.steps?.length > 0 && (
                  <ol className="flex flex-col gap-1.5">
                    {diagnosisFor.steps.map((step, index) => (
                      <li key={step} className="flex items-start gap-2 text-xs text-[#362217]">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F0E7DC] text-[10px] font-bold text-[#5E4C3E]">{index + 1}</span>
                        <span className="pt-0.5">{step}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {diagnosisFor.fixes?.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {diagnosisFor.fixes.map((fix, index) => (
                      <button key={fix.label} type="button" disabled={Boolean(fixing)} onClick={() => applyFix(fix)} className={index === 0 ? buttonClass.primary : buttonClass.secondary}>
                        {fixing === fix.label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : fix.kind === "retry" ? <RotateCcw className="h-3.5 w-3.5" /> : fix.kind === "link" ? <ArrowRight className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />}
                        {fix.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : isDestroyFailed ? (
              <p className="text-sm text-[#5E4C3E]">Some AWS resources may still exist. Retrying is safe: SkyForge checks each one and only deletes what's left.</p>
            ) : <div className="skeleton h-12" />}
            {activeDeployment?.error && (
              <details className="rounded-2xl bg-[#FAF8F5] px-3 py-2 text-[11px] text-[#5E4C3E]">
                <summary className="cursor-pointer font-semibold">Technical details</summary>
                <p className="mt-2 whitespace-pre-wrap break-all font-mono">{activeDeployment.error}</p>
              </details>
            )}
          </div>
        </div>
      )}

      {/* Progress */}
      <section className="rounded-3xl border border-[#EAE1D5] bg-white p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-[#362217]">{isBuilding || isQueued ? "Deploying" : hasLiveEndpoint ? "Last deploy" : isFailed ? "Stopped" : "Pipeline"}</h3>
            <p className="text-xs text-[#5E4C3E]">
              {isQueued ? `Waiting for a worker (${queuePositionLabel} in line)…`
                : isBuilding ? `${STAGES[activeIdx]?.label || "Working"}: ${STAGES[activeIdx]?.desc || ""}`
                : hasLiveEndpoint ? `Finished ${activeDeployment?.completedAt ? timeAgo(activeDeployment.completedAt) : ""}`
                : isFailed ? `Stopped at: ${STAGES[activeIdx]?.label || activeDeployment?.currentStep}`
                : "Press Deploy to build and launch the site."}
            </p>
          </div>
          {elapsed !== null && <span className="font-mono text-2xl font-bold text-[#362217]">{formatDuration(elapsed)}</span>}
        </div>

        <div className="relative mb-4 h-2 overflow-hidden rounded-full bg-[#F0E7DC]">
          <div className={`h-full rounded-full transition-all duration-700 ${isFailed ? "bg-[#C2412D]" : hasLiveEndpoint ? "bg-[#2E6B4F]" : "bg-[#9E5D2D]"}`} style={{ width: `${isFailed ? Math.max(8, progressPercent) : progressPercent}%` }} />
          {(isBuilding || isQueued) && <div className="progress-sheen absolute inset-0" />}
        </div>

        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {STAGES.map((stage, idx) => {
            const done = hasLiveEndpoint || (!isFailed && idx < activeIdx) || (isFailed && idx < activeIdx);
            const running = (isBuilding || isQueued) && idx === activeIdx;
            const failedHere = isFailed && !isDestroyFailed && idx === activeIdx;
            const ms = durationByStage[stage.id];
            return (
              <li key={stage.id} className={`flex flex-col gap-1 rounded-2xl border p-3 transition-all ${failedHere ? "border-[#9E2A2B]/50 bg-[#9E2A2B]/5" : running ? "border-[#9E5D2D] bg-[#9E5D2D]/5 ring-2 ring-[#9E5D2D]/15" : done ? "border-[#2E6B4F]/25 bg-[#2E6B4F]/5" : "border-[#EADFCF] bg-[#FAF8F5]"}`}>
                <div className="flex items-center justify-between">
                  {done ? <CheckCircle2 className="h-4 w-4 text-[#2E6B4F]" /> : failedHere ? <AlertCircle className="h-4 w-4 text-[#9E2A2B]" /> : running ? <Loader2 className="h-4 w-4 animate-spin text-[#9E5D2D]" /> : <span className="h-2 w-2 rounded-full bg-[#DCD0C3]" />}
                  {ms !== undefined && <span className="font-mono text-[10px] text-[#8C7667]">{formatDuration(ms)}</span>}
                </div>
                <span className="text-xs font-bold text-[#362217]">{stage.label}</span>
                <span className="text-[10px] leading-tight text-[#8C7667]">{stage.desc}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {/* Live site */}
      {hasLiveEndpoint && (
        <section className="flex flex-col gap-4 rounded-3xl border-2 border-[#2E6B4F]/30 bg-[#2E6B4F]/5 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#2E6B4F] text-white"><Globe className="h-6 w-6" /></span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-[#2E6B4F]">
                Your site is live
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] text-white ${healthStatus === "HEALTHY" ? "bg-[#2E6B4F]" : "bg-[#D97706]"}`}>{healthStatus === "HEALTHY" ? "Healthy" : `Health: ${healthStatus.toLowerCase()}`}</span>
              </p>
              <a href={customDomain || liveUrl || undefined} target="_blank" rel="noreferrer" className="block truncate font-mono text-base font-bold text-[#362217] hover:text-[#9E5D2D]">{(customDomain || liveUrl || "Address unavailable").replace(/^https?:\/\//, "")}</a>
              <p className="mt-0.5 text-xs text-[#5E4C3E]">Responds in {latency}{customDomain && liveUrl ? ` · also at ${liveUrl.replace(/^https?:\/\//, "")}` : ""}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {(customDomain || liveUrl) && (
              <button type="button" onClick={() => handleCopyUrl(customDomain || liveUrl)} className={buttonClass.secondary}>{copiedUrl ? <Check className="h-3.5 w-3.5 text-[#2E6B4F]" /> : <Copy className="h-3.5 w-3.5" />} {copiedUrl ? "Copied" : "Copy"}</button>
            )}
            <Link to={`/project/${id}/monitor`} className={buttonClass.secondary}><Activity className="h-3.5 w-3.5" /> Logs & metrics</Link>
            {(customDomain || liveUrl) && <a href={customDomain || liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[#2E6B4F] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#24543D]">Open site <ExternalLink className="h-3.5 w-3.5" /></a>}
          </div>
        </section>
      )}

      {/* After teardown */}
      {isDestroyed && (
        <section className="flex flex-col gap-4 rounded-3xl border border-[#DCD0C3] bg-gradient-to-r from-[#FAF8F5] to-[#F3ECE3] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#362217] text-[#E0A36E]"><Trash2 className="h-6 w-6" /></span>
            <div>
              <p className="text-base font-bold text-[#362217]">Everything was removed from AWS</p>
              <p className="max-w-xl text-xs text-[#5E4C3E]">The container, load balancer, image registry, security groups, roles, secrets and logs this project created were deleted and verified gone, so it costs nothing now. Other resources in your account were left alone.</p>
            </div>
          </div>
          <button type="button" onClick={handleTriggerDeploy} disabled={deploying} className={buttonClass.primary}>{deploying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />} Deploy again</button>
        </section>
      )}

      {/* Terminal */}
      <section className="overflow-hidden rounded-3xl border border-[#2A211C] bg-[#1A1411] shadow-lg keep-colors">
        <div className="flex flex-col gap-3 border-b border-[#2E2520] bg-[#221A16] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#E5DED6]">
            <Terminal className="h-4 w-4 text-[#E0A36E]" />
            Deployment log
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-[#BFAEA0]">{visibleLogs.length}{visibleLogs.length !== logs.length ? ` of ${logs.length}` : ""} lines</span>
            {errorCount > 0 && <button type="button" onClick={() => setLogLevel("error")} className="rounded-full bg-[#C2412D]/25 px-2 py-0.5 text-[10px] font-bold text-[#FCA5A5]">{errorCount} error{errorCount === 1 ? "" : "s"}</button>}
            {(isBuilding || isQueued || isDestroying) && <span className="inline-flex items-center gap-1 text-[10px] text-[#4EBA87]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4EBA87]" /> streaming</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-8 items-center gap-1.5 rounded-lg border border-[#3A2E26] bg-[#15100D] px-2">
              <Search className="h-3.5 w-3.5 text-[#8C7F73]" />
              <input value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Search log" className="w-36 bg-transparent text-[11px] text-[#E5DED6] outline-none placeholder:text-[#6F6259]" />
              {logSearch && <button type="button" onClick={() => setLogSearch("")} aria-label="Clear search"><X className="h-3 w-3 text-[#8C7F73]" /></button>}
            </div>
            <div className="flex rounded-lg border border-[#3A2E26] p-0.5">
              {[["all", "All"], ["warn", "Warnings"], ["error", "Errors"]].map(([value, label]) => (
                <button key={value} type="button" onClick={() => setLogLevel(value)} className={`rounded-md px-2 py-1 text-[10px] font-semibold transition ${logLevel === value ? "bg-[#E0A36E] text-[#1A1411]" : "text-[#BFAEA0] hover:bg-white/5"}`}>{label}</button>
              ))}
            </div>
            <button type="button" onClick={handleCopyAllLogs} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#3A2E26] px-2 text-[10px] font-semibold text-[#BFAEA0] hover:bg-white/5">{copiedLogs ? <Check className="h-3 w-3 text-[#4EBA87]" /> : <Copy className="h-3 w-3" />} {copiedLogs ? "Copied" : "Copy"}</button>
            <button type="button" onClick={downloadLogs} disabled={!logs.length} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#3A2E26] px-2 text-[10px] font-semibold text-[#BFAEA0] hover:bg-white/5 disabled:opacity-40"><Download className="h-3 w-3" /> Download</button>
          </div>
        </div>
        <div className="relative">
          <div
            ref={terminalRef}
            onScroll={(event) => {
              const box = event.currentTarget;
              setFollowLogs(box.scrollHeight - box.scrollTop - box.clientHeight < 40);
            }}
            className="flex max-h-[520px] min-h-[220px] flex-col gap-1 overflow-y-auto p-4 font-mono text-[11.5px] leading-relaxed text-[#E5DED6]"
          >
            {logs.length === 0 ? (
              <p className="py-10 text-center italic text-[#8C7F73]">No log yet. Press Deploy and every step appears here as it happens.</p>
            ) : visibleLogs.length === 0 ? (
              <p className="py-10 text-center italic text-[#8C7F73]">No lines match. <button type="button" onClick={() => { setLogSearch(""); setLogLevel("all"); }} className="font-semibold text-[#E0A36E] underline">Show everything</button></p>
            ) : visibleLogs.map((log) => {
              const level = levelOf(log);
              const isDestroy = /^DESTROY/.test(log.stage || "") && level === "info";
              const tone = isDestroy ? "text-[#C7D2FE]" : level === "error" ? "text-[#FF8787] font-semibold" : level === "success" ? "text-[#4EBA87] font-semibold" : level === "warn" ? "text-[#FCD34D]" : "text-[#E6E6E6]";
              const badge = isDestroy ? "bg-[#6366F1]/20 text-[#C7D2FE]" : level === "error" ? "bg-[#9E2A2B]/35 text-[#FF6B6B]" : level === "success" ? "bg-[#2E6B4F]/35 text-[#4EBA87]" : level === "warn" ? "bg-[#D97706]/30 text-[#F59E0B]" : "bg-white/10 text-[#E8C39E]";
              return (
                <div key={log.id} className={`flex items-start gap-2 rounded px-1 py-0.5 transition-colors hover:bg-white/5 ${level === "error" ? "bg-[#9E2A2B]/10" : ""}`}>
                  <span className="shrink-0 select-none text-[#7D6F64]">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span className={`shrink-0 rounded px-1.5 font-mono text-[10px] font-bold uppercase ${badge}`}>{stageInfo(log.stage).label || log.stage}</span>
                  <span className={`whitespace-pre-wrap break-all ${tone}`}>{highlight(log.message)}</span>
                </div>
              );
            })}
          </div>
          {!followLogs && logs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setFollowLogs(true);
                if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
              }}
              className="absolute bottom-4 right-4 inline-flex items-center gap-1 rounded-full bg-[#E0A36E] px-3 py-1.5 text-[11px] font-bold text-[#1A1411] shadow-lg"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" /> Jump to latest
            </button>
          )}
        </div>
      </section>

      {/* Earlier versions */}
      {versions.length > 1 && (
        <section className="rounded-3xl border border-[#EAE1D5] bg-white p-5 sm:p-6">
          <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold text-[#362217]"><History className="h-[18px] w-[18px] text-[#9E5D2D]" /> Versions</h3>
              <p className="text-xs text-[#5E4C3E]">Put any earlier working version back live in about a minute, without rebuilding. {restorable.length ? "" : "Versions become restorable once there are at least two successful deploys on the same infrastructure."}</p>
            </div>
            <Link to="/dashboard/deployments" className="text-xs font-semibold text-[#9E5D2D] hover:underline">Full history →</Link>
          </div>
          <ul className="divide-y divide-[#F0E7DC]">
            {versions.slice(0, 8).map((version) => (
              <li key={version.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-[#362217]">{new Date(version.createdAt).toLocaleString()}</span>
                    {version.isCurrent && <span className="rounded-full bg-[#2E6B4F] px-2 py-0.5 text-[10px] font-bold text-white">Serving now</span>}
                    <span className="text-[11px] text-[#8C7667]">{STATUS_LABELS[version.status] || version.status.toLowerCase().replaceAll("_", " ")}</span>
                  </div>
                  <p className="truncate text-[11px] text-[#5E4C3E]">
                    {version.commitSha ? <><span className="font-mono">{version.commitSha.slice(0, 7)}</span> {version.commitMessage?.split("\n")[0]}</> : "Commit not recorded"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {version.restorable && (
                    <button type="button" disabled={Boolean(restoringId) || isActiveOperation} onClick={() => handleRestore(version)} className={buttonClass.secondary}>
                      {restoringId === version.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Restore
                    </button>
                  )}
                  {version.id !== activeDeployment?.id && <button type="button" onClick={() => openDeployment(version.id)} className={buttonClass.secondary}>View log</button>}
                </div>
              </li>
            ))}
          </ul>
          {current && hasLiveEndpoint && <p className="mt-2 text-[11px] text-[#8C7667]">Restoring keeps the same address; the switch happens only after the old version passes health checks.</p>}
        </section>
      )}

      {/* AWS account */}
      <div className="flex flex-col gap-3 rounded-2xl border border-[#EAE1D5] bg-[#FAF8F5] p-4 text-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-[#2E6B4F]" />
          <span className="font-mono text-[#5E4C3E]">
            {awsConnected ? `AWS account ${awsData?.accountId || "connected"} · ${awsData?.region || "region not set"}${awsData?.maskedAccessKey ? ` · key ${awsData.maskedAccessKey}` : ""}` : "No AWS account connected: connect one to deploy"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => { setAwsRegionInput(awsData?.region || "ap-south-1"); setShowAwsModal(true); }} className="inline-flex items-center gap-1.5 font-semibold text-[#9E5D2D] hover:underline"><Key className="h-3.5 w-3.5" /> {awsConnected ? "Update AWS keys" : "Connect AWS"}</button>
          {hasLiveEndpoint && <button type="button" onClick={() => setShowRollbackModal(true)} disabled={rollingBack || destroying} className="inline-flex items-center gap-1.5 font-semibold text-[#6D28D9] hover:underline disabled:opacity-50"><Undo2 className="h-3.5 w-3.5" /> Roll back to previous</button>}
        </div>
      </div>

      {/* Rollback Confirmation Modal */}
      {showRollbackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="rollback-dialog-title" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-4">
            <div className="flex items-center gap-3 text-[#6D28D9]">
              <div className="p-3 rounded-2xl bg-[#6D28D9]/10">
                <Undo2 className="h-6 w-6" />
              </div>
              <div>
                <h3 id="rollback-dialog-title" className="text-lg font-bold text-[#362217]">Rollback Deployment</h3>
                <p className="text-xs text-[#5E4C3E]">Restore previous stable service revision</p>
              </div>
            </div>

            <p className="text-xs text-[#5E4C3E] leading-relaxed">
              The rollback worker restores the compatible previous task definition, waits for ECS service stability, then verifies the live endpoint.
            </p>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="rollback-reason" className="text-xs font-bold text-[#362217]">Rollback Reason / Notes</label>
              <input
                type="text"
                id="rollback-reason"
                 value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2 text-xs text-[#362217] outline-none focus:border-[#9E5D2D]"
                placeholder="Reason for rolling back..."
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRollbackModal(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRollback}
                loading={rollingBack}
                className="bg-[#6D28D9] hover:bg-[#5B21B6] text-white font-bold"
              >
                Confirm Rollback
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* One-Click Destroy Confirmation Modal */}
      {showDestroyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="destroy-dialog-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-5">
            <div className="flex items-center gap-3.5 text-[#9E2A2B]">
              <div className="p-3 rounded-2xl bg-[#9E2A2B]/10">
                <Flame className="h-6 w-6 text-[#9E2A2B]" />
              </div>
              <div>
                <h3 id="destroy-dialog-title" className="text-lg font-bold text-[#362217]">
                  One-Click AWS Infrastructure Teardown
                </h3>
                <p className="text-xs text-[#5E4C3E]">
                  Permanently delete all cloud services & prevent ongoing costs
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-[#9E2A2B]/5 border border-[#9E2A2B]/20 text-xs text-[#7E2223] flex flex-col gap-2">
              <span className="font-bold flex items-center gap-1.5 text-[#9E2A2B]">
                <AlertTriangle className="h-4 w-4" />
                Caution: Permanent Cloud Deletion via STS Role
              </span>
              <p className="text-[11px] leading-relaxed text-[#5E4C3E]">
                This will assume your connected IAM role (<strong>{awsData?.accountId || "Connected Account"}</strong> in <strong>{awsData?.region || "ap-south-1"}</strong>) and forcefully decommission every resource associated with this project:
              </p>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1 font-mono text-[10px] text-[#362217]">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  ECS Fargate cluster, service & task definitions
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Application Load Balancer, listener & target group
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  ECR repository & all images
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Secrets Manager secret (environment values)
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  WAF firewall & ban list (Protected tier)
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Canary IAM user & access key
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  IAM execution & task roles
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Project security groups (shared VPC kept)
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  CloudWatch log group
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Legacy S3 / CloudFront releases
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9E2A2B]" />
                  Local build workspace
                </li>
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-[#2E6B4F]">
                Afterwards SkyForge searches your AWS account for anything else named for this project and only reports success once AWS confirms nothing is left, so the project stops incurring charges. To pause instead, use <strong>Take site offline</strong> on the Security page.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDestroyModal(false)}
                disabled={destroying}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDestroy}
                loading={destroying}
                className="bg-[#9E2A2B] hover:bg-[#7E2223] text-white font-bold flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                <span>Permanently Destroy All AWS Resources</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Direct AWS Credentials Input Modal */}
      {showAwsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#362217]/60 backdrop-blur-xs p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="aws-dialog-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl border border-[#EAE1D5] flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-[#EADFCF] pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#9E5D2D] text-white">
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="aws-dialog-title" className="text-lg font-bold text-[#362217]">
                    Connect AWS Account Credentials
                  </h3>
                  <p className="text-xs text-[#5E4C3E]">
                    Configure IAM Access Keys for deployment
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close AWS credentials dialog"
                onClick={() => setShowAwsModal(false)}
                className="text-[#8C7667] hover:text-[#362217] p-1.5 rounded-lg hover:bg-[#FAF8F5] transition"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {awsModalNotice && (
              <div
                className={`p-3 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                  awsModalNotice.type === "success"
                    ? "bg-[#2E6B4F]/10 text-[#2E6B4F] border-[#2E6B4F]/20"
                    : "bg-[#9E2A2B]/10 text-[#9E2A2B] border-[#9E2A2B]/20"
                }`}
              >
                {awsModalNotice.type === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{awsModalNotice.message}</span>
              </div>
            )}

            <form onSubmit={handleSaveAwsModalCredentials} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Access Key ID
                </label>
                <div className="relative flex items-center">
                  <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                    <Key className="h-4 w-4" />
                  </div>
                  <input
                    type="text"
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    value={awsAccessKeyInput}
                    onChange={(e) => setAwsAccessKeyInput(e.target.value)}
                    required
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Secret Access Key
                </label>
                <div className="relative flex items-center">
                  <div className="pointer-events-none absolute left-3.5 text-[#8C7667]">
                    <Lock className="h-4 w-4" />
                  </div>
                  <input
                    type={showAwsSecret ? "text" : "password"}
                    placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                    value={awsSecretKeyInput}
                    onChange={(e) => setAwsSecretKeyInput(e.target.value)}
                    required
                    className="w-full rounded-xl border border-[#DCD0C3] bg-white pl-10 pr-10 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                  />
                  <button
                    type="button"
                    aria-label={showAwsSecret ? "Hide AWS secret access key" : "Show AWS secret access key"}
                    onClick={() => setShowAwsSecret(!showAwsSecret)}
                    className="absolute right-3 text-[#8C7667] hover:text-[#362217]"
                  >
                    {showAwsSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="aws-session-token" className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Session Token (temporary credentials only)
                </label>
                <input
                  id="aws-session-token"
                  type={showAwsSecret ? "text" : "password"}
                  placeholder="Required for credentials issued by STS"
                  value={awsSessionTokenInput}
                  onChange={(event) => setAwsSessionTokenInput(event.target.value)}
                  autoComplete="off"
                  className="w-full rounded-xl border border-[#DCD0C3] bg-white px-4 py-2.5 text-xs font-mono text-[#362217] placeholder-[#A39284] outline-none transition focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D]"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="aws-modal-region" className="text-xs font-semibold text-[#5E4C3E]">
                  AWS Deployment Region
                </label>
                <select
                  id="aws-modal-region"
                  value={awsRegionInput}
                  onChange={(e) => setAwsRegionInput(e.target.value)}
                  className="w-full rounded-xl border border-[#DCD0C3] bg-white px-3 py-2.5 text-xs text-[#362217] outline-none focus:border-[#9E5D2D] focus:ring-1 focus:ring-[#9E5D2D] transition shadow-xs"
                >
                  <option value="ap-south-1">ap-south-1 (Mumbai)</option>
                  <option value="us-east-1">us-east-1 (N. Virginia)</option>
                  <option value="us-west-2">us-west-2 (Oregon)</option>
                  <option value="eu-west-1">eu-west-1 (Ireland)</option>
                  <option value="eu-central-1">eu-central-1 (Frankfurt)</option>
                  <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                </select>
              </div>

              <p className="text-[11px] text-[#8C7667] leading-relaxed">
                Credentials are encrypted at rest and verified using AWS STS. They are used for the ECS Fargate and Application Load Balancer deployment path.
              </p>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[#EAE1D5]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAwsModal(false)}
                  disabled={savingAwsKeys}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={savingAwsKeys}
                  className="bg-[#2E6B4F] hover:bg-[#24543D] text-white font-bold flex items-center gap-1.5"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Save & Verify AWS Keys
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
