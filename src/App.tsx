import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Row, Col, Typography, Space, ConfigProvider, message, Tooltip } from 'antd';
import { 
  PlusOutlined, 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  HeartFilled,
  AppstoreFilled,
  ExperimentFilled,
  ReloadOutlined,
  DeleteFilled,
  LogoutOutlined
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import PromptDrawer from './components/PromptDrawer';
import CollectionBox from './components/CollectionBox';
import TaskGrid from './components/TaskGrid';
import ConfigDrawer from './components/ConfigDrawer';
import type { AppConfig, TaskConfig } from './types/app';
import type { CollectionItem } from './types/collection';
import type { GlobalStats } from './types/stats';
import type { PersistedUploadImage } from './types/imageTask';
import {
  cleanupTaskCache,
  cleanupUnusedImageCache,
  collectTaskImageKeys,
  deleteImageCache,
  type FormatConfig,
  buildFormatConfig,
  getDefaultFormatConfig,
  getTaskStorageKey,
  loadCollectionItems,
  loadConfig,
  loadFormatConfig,
  loadGlobalStats,
  loadTasks,
  saveConfig,
  saveCollectionItems,
  STORAGE_KEYS,
} from './app/storage';
import { useDebouncedSync, useInputGuard } from './utils/inputSync';
import {
  type ApiFormat,
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from './utils/apiUrl';
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  deleteBackendTask,
  fetchBackendCollection,
  fetchBackendModels,
  fetchBackendState,
  buildBackendStreamUrl,
  patchBackendState,
  putBackendTask,
  putBackendCollection,
  type BackendState,
} from './utils/backendApi';

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};
const API_FORMATS: ApiFormat[] = ['openai', 'gemini', 'vertex'];

type FormatConfigMap = Record<ApiFormat, FormatConfig>;

interface AppProps {
  onLogout?: () => void;
}

const buildBackendFormatConfigs = (
  value: unknown,
  fallbackConfig?: AppConfig,
): FormatConfigMap => {
  const next = API_FORMATS.reduce((acc, format) => {
    acc[format] = getDefaultFormatConfig(format);
    return acc;
  }, {} as FormatConfigMap);
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    API_FORMATS.forEach((format) => {
      const entry = raw[format];
      if (entry && typeof entry === 'object') {
        next[format] = { ...next[format], ...buildFormatConfig(entry as Partial<AppConfig>) };
      }
    });
  }
  if (fallbackConfig?.apiFormat) {
    next[fallbackConfig.apiFormat] = {
      ...next[fallbackConfig.apiFormat],
      ...buildFormatConfig(fallbackConfig),
    };
  }
  return next;
};

function App({ onLogout }: AppProps) {
  const backendMode = true;
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() => []);
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [collectionVisible, setCollectionVisible] = useState(false);
  const [collectedItems, setCollectedItems] = useState<CollectionItem[]>(() => []);
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [form] = Form.useForm();
  const [backendSyncing, setBackendSyncing] = useState(false);
  const backendModeRef = useRef(true);
  const configRef = useRef(config);
  const configVisibleRef = useRef(configVisible);
  const backendFormatConfigsRef = useRef<FormatConfigMap>(
    buildBackendFormatConfigs(null),
  );
  const localHydratingRef = useRef(false);
  const backendApplyingRef = useRef(false);
  const backendBootstrappedRef = useRef(false);
  const backendReadyRef = useRef(false);
  const backendCollectionHydratingRef = useRef(false);
  const backendCollectionSyncTimerRef = useRef<number | null>(null);
  const backendCollectionLastPayloadRef = useRef<string>('');
  const collectedItemsRef = useRef(collectedItems);
  const collectionCountRef = useRef(collectedItems.length);
  const configGuard = useInputGuard({
    isEditing: () => configVisibleRef.current,
    idleMs: 700,
  });
  const backendConfigPayload =
    backendMode && backendReadyRef.current
      ? { config, configByFormat: backendFormatConfigsRef.current }
      : null;
  const syncBackendConfig = useCallback(
    (payload: { config: AppConfig; configByFormat: FormatConfigMap }) => {
      void patchBackendState(payload).catch((err) => {
        console.warn('后端配置同步失败:', err);
      });
    },
    [],
  );
  const configSync = useDebouncedSync({
    enabled: backendMode && backendReadyRef.current,
    payload: backendConfigPayload,
    delay: 500,
    retryDelay: 200,
    isBlocked: () => backendApplyingRef.current,
    onSync: syncBackendConfig,
  });
  const {
    markDirty: markConfigDirty,
    clearDirty: clearConfigDirty,
    shouldPreserve: shouldPreserveConfig,
  } = configGuard;
  const { markSynced: markConfigSynced } = configSync;

  const applyBackendState = useCallback((state: BackendState) => {
      if (!backendModeRef.current) return;
      backendApplyingRef.current = true;
      backendReadyRef.current = true;
      if (state?.config) {
        const formatConfigs = buildBackendFormatConfigs(
          state.configByFormat,
          state.config,
        );
        const incomingKey = JSON.stringify(state.config);
        const currentKey = JSON.stringify(configRef.current);
        const preserveConfig = shouldPreserveConfig(incomingKey, currentKey);
        if (preserveConfig) {
          const localConfig = configRef.current;
          const localFormat =
            localConfig.apiFormat === 'gemini' || localConfig.apiFormat === 'vertex'
              ? localConfig.apiFormat
              : 'openai';
          formatConfigs[localFormat] = {
            ...formatConfigs[localFormat],
            ...buildFormatConfig(localConfig),
          };
          backendFormatConfigsRef.current = formatConfigs;
          if (incomingKey === currentKey) {
            clearConfigDirty();
          }
        } else {
          backendFormatConfigsRef.current = formatConfigs;
          setConfig(state.config);
          clearConfigDirty();
        }
        markConfigSynced({
          config: state.config,
          configByFormat: formatConfigs,
        });
        const needsFormatSync =
          !state.configByFormat ||
          API_FORMATS.some((format) => !state.configByFormat?.[format]);
        if (needsFormatSync) {
          window.setTimeout(() => {
            if (!backendModeRef.current) return;
            void patchBackendState({ configByFormat: formatConfigs }).catch((err) => {
              console.warn('后端配置缓存补全失败:', err);
            });
          }, 240);
        }
      }
      const order = Array.isArray(state?.tasksOrder) ? state.tasksOrder : [];
      setTasks(order.map((id) => ({ id, prompt: '' })));
      if (state?.globalStats) {
        setGlobalStats(state.globalStats);
      }
      window.setTimeout(() => {
        backendApplyingRef.current = false;
      }, 200);
    }, [form]);

  const bootstrapBackendState = useCallback(async () => {
    setBackendSyncing(true);
    try {
      const state = await fetchBackendState();
      if (!backendModeRef.current) return;
      if (state.tasksOrder.length === 0) {
        const seededFormatConfigs = buildBackendFormatConfigs(null, config);
        backendFormatConfigsRef.current = seededFormatConfigs;
        await patchBackendState({
          config,
          configByFormat: seededFormatConfigs,
        });
        applyBackendState({ ...state, config, configByFormat: seededFormatConfigs });
        const newTaskId = uuidv4();
        await putBackendTask(newTaskId, {
          version: TASK_STATE_VERSION,
          prompt: '',
          concurrency: 2,
          enableSound: true,
          results: [],
          uploads: [],
          stats: DEFAULT_TASK_STATS,
        });
        await patchBackendState({ tasksOrder: [newTaskId] });
        if (backendModeRef.current) {
          setTasks([{ id: newTaskId, prompt: '' }]);
        }
        return;
      }
      applyBackendState(state);
    } catch (err: any) {
      console.error(err);
      message.error('后端模式初始化失败，请检查密码或服务状态');
      localHydratingRef.current = true;
      const localConfig = loadConfig();
      setConfig(localConfig);
      setTasks(loadTasks());
      setGlobalStats(loadGlobalStats());
    } finally {
      setBackendSyncing(false);
    }
  }, [applyBackendState, config]);

  React.useEffect(() => {
    backendModeRef.current = backendMode;
  }, [backendMode]);

  React.useEffect(() => {
    configRef.current = config;
  }, [config]);

  React.useEffect(() => {
    configVisibleRef.current = configVisible;
    if (!configVisible) {
      clearConfigDirty();
    }
  }, [configVisible, clearConfigDirty]);

  React.useEffect(() => {
    if (!configVisible) return;
    form.setFieldsValue(config);
  }, [configVisible, config, form]);

  React.useEffect(() => {
    let isActive = true;
    if (backendMode) {
      backendCollectionHydratingRef.current = true;
      backendCollectionLastPayloadRef.current = JSON.stringify(collectedItemsRef.current);
      void (async () => {
        try {
          const items = await fetchBackendCollection();
          if (!isActive) return;
          const payload = JSON.stringify(items);
          backendCollectionLastPayloadRef.current = payload;
          setCollectedItems(items);
        } catch (err) {
          console.warn('后端收藏读取失败:', err);
        } finally {
          if (isActive) {
            backendCollectionHydratingRef.current = false;
          }
        }
      })();
      return () => {
        isActive = false;
      };
    }

    backendCollectionHydratingRef.current = false;
    backendCollectionLastPayloadRef.current = '';
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
      backendCollectionSyncTimerRef.current = null;
    }
    const localItems = loadCollectionItems();
    const filteredItems = localItems.filter((item) => {
      const localKey = item.localKey || '';
      if (localKey && isBackendImageKey(localKey)) return false;
      if (typeof item.image === 'string' && item.image.includes('/api/backend/image/')) {
        return false;
      }
      return true;
    });
    setCollectedItems(filteredItems);
    return () => {
      isActive = false;
    };
  }, [backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (localHydratingRef.current) return;
    saveCollectionItems(collectedItems);
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    collectedItemsRef.current = collectedItems;
  }, [collectedItems]);

  React.useEffect(() => {
    if (!backendMode) return;
    if (backendCollectionHydratingRef.current) return;
    const payload = JSON.stringify(collectedItems);
    if (payload === backendCollectionLastPayloadRef.current) return;
    backendCollectionLastPayloadRef.current = payload;
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
    }
    backendCollectionSyncTimerRef.current = window.setTimeout(() => {
      void putBackendCollection(collectedItems).catch((err) => {
        console.warn('后端收藏保存失败:', err);
      });
    }, 300);
    return () => {
      if (backendCollectionSyncTimerRef.current) {
        clearTimeout(backendCollectionSyncTimerRef.current);
        backendCollectionSyncTimerRef.current = null;
      }
    };
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    if (collectionCountRef.current > collectedItems.length) {
      setCollectionRevision((prev) => prev + 1);
    }
    collectionCountRef.current = collectedItems.length;
  }, [collectedItems.length]);

  React.useEffect(() => {
    if (config.enableCollection) return;
    if (backendMode) return;
    if (localHydratingRef.current) return;
    const keepKeys = collectTaskImageKeys(tasks.map((task) => task.id));
    void cleanupUnusedImageCache(keepKeys);
  }, [config.enableCollection, tasks, backendMode]);

  React.useEffect(() => {
    if (!backendMode) {
      backendBootstrappedRef.current = false;
      backendReadyRef.current = false;
      return;
    }
    if (backendBootstrappedRef.current) return;
    backendBootstrappedRef.current = true;
    void bootstrapBackendState();
  }, [backendMode, bootstrapBackendState]);

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    navigator.storage.persist().catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (backendMode) return;
    if (localHydratingRef.current) return;
    saveConfig(config);
  }, [config, backendMode]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ tasksOrder: tasks.map((task: TaskConfig) => task.id) }).catch((err) => {
        console.warn('后端任务列表同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.tasks,
      JSON.stringify(tasks.map((task: TaskConfig) => task.id)),
      'app cache',
    );
  }, [tasks, backendMode]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ globalStats }).catch((err) => {
        console.warn('后端统计同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.globalStats,
      JSON.stringify(globalStats),
      'app cache',
    );
  }, [globalStats, backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (!localHydratingRef.current) return;
    localHydratingRef.current = false;
  }, [backendMode]);

  React.useEffect(() => {
    if (!backendMode) return;
    const streamUrl = buildBackendStreamUrl();
    const source = new EventSource(streamUrl);
    const handleState = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        applyBackendState(payload);
      } catch (err) {
        console.warn('解析后端状态事件失败:', err);
      }
    };
    const handleTask = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        window.dispatchEvent(new CustomEvent('backend-task-update', { detail: payload }));
      } catch (err) {
        console.warn('解析后端任务事件失败:', err);
      }
    };
    source.addEventListener('state', handleState as EventListener);
    source.addEventListener('task', handleTask as EventListener);
    source.onerror = () => {
      console.warn('后端事件流断开，等待自动重连');
    };
    return () => {
      source.removeEventListener('state', handleState as EventListener);
      source.removeEventListener('task', handleTask as EventListener);
      source.close();
    };
  }, [backendMode, applyBackendState]);

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const modelOptions = await fetchBackendModels({});
      setModels(modelOptions);
      message.success(`成功获取 ${modelOptions.length} 个模型`);
    } catch (e) {
      console.error(e);
      message.error('获取模型列表失败，请检查配置');
    } finally {
      setLoadingModels(false);
    }
  };

  // 当配置抽屉打开且有 API Key 时，如果列表为空，自动获取一次
  React.useEffect(() => {
    if (!configVisible) return;
  }, [configVisible]);

  const handleAddTask = () => {
    const newTaskId = uuidv4();
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: '',
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    }
    setTasks([...tasks, { id: newTaskId, prompt: '' }]);
  };

  const handleReorderTasks = useCallback((nextTasks: TaskConfig[]) => {
    setTasks(nextTasks);
  }, []);

  const handleCreateTaskFromPrompt = (prompt: string) => {
    const newTaskId = uuidv4();
    
    // Pre-save task state with prompt
    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        // If we could handle image upload here we would, but for now just prompt
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      });
    }

    setTasks([...tasks, { id: newTaskId, prompt }]);
  };

  const handleCreateTaskFromCollection = (prompt: string, referenceImages: CollectionItem[]) => {
    const newTaskId = uuidv4();
    
    const uploads: PersistedUploadImage[] = referenceImages
      .filter((img) => img.localKey)
      .map((img) => {
        const uid = uuidv4();
        return {
          uid,
          name: `reference-${uid.slice(0, 8)}.png`,
          type: 'image/png',
          localKey: img.localKey as string,
          lastModified: Date.now(),
          fromCollection: true,
          sourceSignature: img.sourceSignature,
        };
      });

    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      });
    }

    setTasks([...tasks, { id: newTaskId, prompt }]);
    setCollectionVisible(false);
    message.success('已创建新任务');
  };

  const isCollectionCacheKey = (key: string) => key.startsWith('collection:');
  const isBackendImageKey = (key: string) => /\.[a-z0-9]+$/i.test(key);
  const getBackendFormatConfig = (format: ApiFormat) =>
    backendFormatConfigsRef.current[format];

  const handleRemoveTask = (id: string) => {
    if (backendMode) {
      void deleteBackendTask(id).catch((err) => {
        console.error(err);
        message.error('删除后端任务失败');
      });
    } else {
      const storageKey = getTaskStorageKey(id);
      const preserveKeys = config.enableCollection
        ? collectedItems
            .filter(
              (item) =>
                item.taskId === id &&
                typeof item.localKey === 'string' &&
                !isCollectionCacheKey(item.localKey) &&
                !isBackendImageKey(item.localKey),
            )
            .map((item) => item.localKey as string)
        : [];
      if (preserveKeys.length > 0) {
        void cleanupTaskCache(storageKey, { preserveImageKeys: preserveKeys });
      } else {
        void cleanupTaskCache(storageKey);
      }
    }
    setTasks(tasks.filter((t: TaskConfig) => t.id !== id));
  };

  const handleConfigChange = (changedValues: any, allValues: AppConfig) => {
    const nextFormat = allValues.apiFormat || config.apiFormat;
    let nextConfig = { ...config, ...allValues, apiFormat: nextFormat };
    const formatChanged =
      typeof changedValues?.apiFormat === 'string' &&
      changedValues.apiFormat !== config.apiFormat;

    if (backendMode) {
      markConfigDirty();
    }

    if (formatChanged) {
      const formatConfig = backendMode
        ? getBackendFormatConfig(nextFormat)
        : loadFormatConfig(nextFormat);
      nextConfig = { ...nextConfig, ...formatConfig, apiFormat: nextFormat };
      form.setFieldsValue({
        apiUrl: formatConfig.apiUrl,
        apiKey: formatConfig.apiKey,
        model: formatConfig.model,
        apiVersion: formatConfig.apiVersion,
        vertexProjectId: formatConfig.vertexProjectId,
        vertexLocation: formatConfig.vertexLocation,
        vertexPublisher: formatConfig.vertexPublisher,
        thinkingBudget: formatConfig.thinkingBudget,
        includeThoughts: formatConfig.includeThoughts,
        includeImageConfig: formatConfig.includeImageConfig,
        includeSafetySettings: formatConfig.includeSafetySettings,
        safety: formatConfig.safety,
        imageConfig: formatConfig.imageConfig,
        webpQuality: formatConfig.webpQuality,
        useResponseModalities: formatConfig.useResponseModalities,
        customJson: formatConfig.customJson,
      });
      setModels([]);
    }

    if (typeof nextConfig.apiUrl === 'string') {
      const inferredVersion = inferApiVersionFromUrl(nextConfig.apiUrl);
      if (inferredVersion && inferredVersion !== nextConfig.apiVersion) {
        nextConfig.apiVersion = inferredVersion;
        form.setFieldsValue({ apiVersion: inferredVersion });
      }
      if (nextFormat === 'vertex') {
        const inferredProjectId = extractVertexProjectId(nextConfig.apiUrl);
        if (inferredProjectId && inferredProjectId !== nextConfig.vertexProjectId) {
          nextConfig.vertexProjectId = inferredProjectId;
          form.setFieldsValue({ vertexProjectId: inferredProjectId });
        }
      }
    }

    if (backendMode) {
      backendFormatConfigsRef.current = {
        ...backendFormatConfigsRef.current,
        [nextConfig.apiFormat]: buildFormatConfig(nextConfig),
      };
    }

    setConfig(nextConfig);
  };

  const normalizePrompt = (prompt: string) =>
    prompt.trim().replace(/\s+/g, ' ');

  const buildPromptKey = (prompt: string) => {
    const normalized = normalizePrompt(prompt);
    return normalized ? normalized.toLowerCase() : '__empty__';
  };

  const isUploadCollectionKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:upload:'));

  const isUploadCollectionItem = (item: CollectionItem) =>
    isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey);

  const getCollectionGroupKey = (item: CollectionItem) =>
    buildPromptKey(typeof item.prompt === 'string' ? item.prompt : '');

  const getCollectionKey = (item: CollectionItem, useIdOnly = false) => {
    if (isUploadCollectionItem(item) && item.sourceSignature) {
      return `upload:${buildPromptKey(item.prompt)}:${item.sourceSignature}`;
    }
    return useIdOnly ? item.id : item.localKey || item.image || item.id;
  };


  const handleCollect = (item: CollectionItem) => {
    const normalized: CollectionItem = {
      ...item,
      id: item.id || item.localKey || uuidv4(),
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
    };
    const incomingKey = getCollectionKey(normalized, backendMode);
    setCollectedItems((prev) => {
      if (!incomingKey) return [normalized, ...prev];
      const existingIndex = prev.findIndex(
        (entry) => getCollectionKey(entry, backendMode) === incomingKey,
      );
      if (existingIndex === -1) {
        return [normalized, ...prev];
      }
      const existing = prev[existingIndex];
      const updated = { ...existing, ...normalized, id: existing.id || normalized.id };
      const next = prev.filter(
        (entry) => getCollectionKey(entry, backendMode) !== incomingKey,
      );
      return [updated, ...next];
    });
  };

  const getCollectionCacheKey = (item: CollectionItem) => {
    if (item.localKey) return item.localKey;
    if (item.id && isCollectionCacheKey(item.id)) return item.id;
    return undefined;
  };

  const handleRemoveCollectedItem = (id: string) => {
    setCollectedItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (!backendMode) {
        const cacheKey = target ? getCollectionCacheKey(target) : undefined;
        if (cacheKey) {
          void deleteImageCache(cacheKey);
        }
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleRemoveCollectedGroup = (groupKey: string) => {
    setCollectedItems((prev) => {
      const toRemove = prev.filter(
        (item) => getCollectionGroupKey(item) === groupKey,
      );
      if (!backendMode) {
        const keys = Array.from(
          new Set(
            toRemove
              .map((item) => getCollectionCacheKey(item))
              .filter((key): key is string => typeof key === 'string'),
          ),
        );
        keys.forEach((key) => {
          void deleteImageCache(key);
        });
      }
      return prev.filter((item) => getCollectionGroupKey(item) !== groupKey);
    });
  };

  const handleClearCollection = () => {
    if (!backendMode) {
      const keys = Array.from(
        new Set(
          collectedItems
            .map((item) =>
              getCollectionCacheKey(item),
            )
            .filter((key): key is string => typeof key === 'string'),
        ),
      );
      keys.forEach((key) => {
        void deleteImageCache(key);
      });
    }
    setCollectedItems([]);
  };

  const updateGlobalStats = useCallback((type: 'request' | 'success' | 'fail', duration?: number) => {
    setGlobalStats((prev: GlobalStats) => {
      const newState = {
        ...prev,
        totalRequests: type === 'request' ? prev.totalRequests + 1 : prev.totalRequests,
        successCount: type === 'success' ? prev.successCount + 1 : prev.successCount,
      };

      if (type === 'success' && duration) {
        newState.totalTime = prev.totalTime + duration;
        newState.fastestTime = prev.fastestTime === 0 ? duration : Math.min(prev.fastestTime, duration);
        newState.slowestTime = Math.max(prev.slowestTime, duration);
      }

      return newState;
    });
  }, []);

  const handleClearGlobalStats = () => {
    setGlobalStats({ ...EMPTY_GLOBAL_STATS });
    message.success('数据总览统计已清空');
  };

  const successRate = calculateSuccessRate(
    globalStats.totalRequests,
    globalStats.successCount,
  );
  
  const averageTime = globalStats.successCount > 0 
    ? formatDuration(globalStats.totalTime / globalStats.successCount)
    : '0.0s';
  
  const fastestTimeStr = formatDuration(globalStats.fastestTime);

  const slowestTimeStr = formatDuration(globalStats.slowestTime);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#FF9EB5',
          colorTextBase: '#665555',
          colorBgBase: '#FFF9FA',
          borderRadius: 20,
          fontFamily: "'Nunito', 'Quicksand', sans-serif",
        },
        components: {
          Button: {
            colorPrimary: '#FF9EB5',
            algorithm: true,
            fontWeight: 700,
          },
          Input: {
            colorBgContainer: '#FFF0F3',
            activeBorderColor: '#FF9EB5',
            hoverBorderColor: '#FFB7C5',
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          }
        }
      }}
    >
      <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
        {/* 顶部导航栏 */}
        <Header className="app-header" style={{ 
          height: 72, 
          // padding handled in css
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.5)',
          boxShadow: '0 4px 20px rgba(255, 158, 181, 0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="hover-scale" style={{ 
              width: 40, 
              height: 40, 
              background: 'linear-gradient(135deg, #FF9EB5 0%, #FF7090 100%)', 
              borderRadius: 14, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(255, 158, 181, 0.4)',
              transform: 'rotate(-6deg)',
            }}>
              <HeartFilled style={{ fontSize: 20, color: '#fff' }} />
            </div>
            <div>
              <Title level={4} style={{ margin: 0, color: '#665555', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
            </div>
          </div>

          <Space size={8} className="header-actions">
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                广场
              </Button>
            </Tooltip>
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                shape="circle"
                className="desktop-hidden circle-icon-btn"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
            />
            
            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              className="mobile-hidden"
            >
              生成设置
            </Button>
            <Button 
              icon={<SettingFilled />} 
              onClick={() => setConfigVisible(true)}
              size="large"
              shape="circle"
              className="desktop-hidden circle-icon-btn"
            />
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={handleAddTask}
              size="large"
            >
              新建任务
            </Button>
            {onLogout ? (
              <>
                <Button
                  icon={<LogoutOutlined />}
                  onClick={onLogout}
                  size="large"
                  className="mobile-hidden"
                  style={{
                    background: 'rgba(255,255,255,0.6)',
                    border: '1px solid #FF9EB5',
                    color: '#FF9EB5'
                  }}
                >
                  退出登录
                </Button>
                <Button
                  icon={<LogoutOutlined />}
                  onClick={onLogout}
                  size="large"
                  shape="circle"
                  className="desktop-hidden circle-icon-btn"
                />
              </>
            ) : null}
          </Space>
        </Header>
        
        <Content style={{ padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          
          {/* 数据仪表盘 - 重新设计 */}
          <div className="fade-in-up" style={{ marginBottom: 32 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 16,
                paddingLeft: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AppstoreFilled style={{ fontSize: 18, color: '#FF9EB5' }} />
                <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
                  数据总览
                </Text>
              </div>
              <Button
                size="small"
                icon={<DeleteFilled />}
                onClick={handleClearGlobalStats}
                disabled={backendSyncing}
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                清空统计
              </Button>
            </div>
            
            <div className="stat-panel">
              <Row gutter={[16, 16]}>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E0F7FA', color: '#00BCD4',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value">{globalStats.totalRequests}</div>
                    <div className="stat-label">总请求数</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E8F5E9', color: '#4CAF50',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <CheckCircleFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#4CAF50' }}>{globalStats.successCount}</div>
                    <div className="stat-label">成功生成</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFF8E1', color: '#FFC107',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ExperimentFilled />
                    </div>
                    <div className="stat-value" style={{ color: successRate > 80 ? '#4CAF50' : '#FFC107' }}>
                      {successRate}%
                    </div>
                    <div className="stat-label">成功率</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E3F2FD', color: '#2196F3',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#2196F3' }}>{fastestTimeStr}</div>
                    <div className="stat-label">最快用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFEBEE', color: '#FF5252',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#FF5252' }}>{slowestTimeStr}</div>
                    <div className="stat-label">最慢用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#F3E5F5', color: '#9C27B0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ReloadOutlined />
                    </div>
                    <div className="stat-value" style={{ color: '#9C27B0' }}>{averageTime}</div>
                    <div className="stat-label">平均用时</div>
                  </div>
                </Col>
              </Row>
            </div>
          </div>

          {/* 任务列表 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, paddingLeft: 4 }}>
            <div style={{ 
              width: 24, height: 24, borderRadius: '50%', background: '#FF9EB5', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              fontSize: 12, fontWeight: 700
            }}>
              {tasks.length}
            </div>
            <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
              进行中的任务
            </Text>
          </div>

          <TaskGrid
            tasks={tasks}
            config={config}
            backendMode={backendMode}
            collectionRevision={collectionRevision}
            onRemoveTask={handleRemoveTask}
            onStatsUpdate={updateGlobalStats}
            onCollect={handleCollect}
            onReorder={handleReorderTasks}
          />
        </Content>

        <PromptDrawer 
          visible={promptDrawerVisible}
          onClose={() => setPromptDrawerVisible(false)}
          onCreateTask={handleCreateTaskFromPrompt}
        />
        
        {config.enableCollection && (
          <CollectionBox
            visible={collectionVisible}
            backendMode={backendMode}
            onClose={() => setCollectionVisible(!collectionVisible)}
            collectedItems={collectedItems}
            onRemoveItem={handleRemoveCollectedItem}
            onRemoveGroup={handleRemoveCollectedGroup}
            onClear={handleClearCollection}
            onCreateTask={handleCreateTaskFromCollection}
          />
        )}

        <ConfigDrawer
          visible={configVisible}
          config={config}
          form={form}
          onClose={() => {
            setConfigVisible(false);
          }}
          onConfigChange={handleConfigChange}
          models={models}
          loadingModels={loadingModels}
          fetchModels={fetchModels}
        />

      </Layout>
    </ConfigProvider>
  );
}

export default App;

