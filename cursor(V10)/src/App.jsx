import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDialog } from './components/DialogProvider';
import {
    X, Minus, Square, Layout, Settings, Folder, Plus, History,
    FileCode, Clock, ArrowUp, AlertCircle, CheckCircle2, Search,
    Cpu, Zap, ChevronRight, ExternalLink, Copy, Trash2, Edit3,
    MoreHorizontal, PlusCircle, Terminal, Code2, Save, Bot, Globe, Brain,
    GitBranch, FlaskConical, Sparkles, Wand2, RotateCcw, RefreshCw, BarChart3
} from 'lucide-react';
import SkillsSettingsPanel from './components/SkillsSettingsPanel';
import VersionSettingsPanel from './components/VersionSettingsPanel';
import SuggestionsSettingsPanel from './components/SuggestionsSettingsPanel';
import ProjectView from './ProjectView';
import WorkflowPanel from './components/WorkflowPanel';
import WorkflowBattlePanel from './components/WorkflowBattlePanel';
import TokenDashboard from './components/TokenDashboard';

// ============================================================
// 通知提示组件
// ============================================================
const Toast = ({ message, type = 'success', onClose }) => {
    useEffect(() => {
        const timer = setTimeout(onClose, 3000);
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <div className={`fixed bottom-6 right-6 flex items-center gap-3 border px-4 py-3 rounded-xl shadow-2xl animate-slide-in-right z-[100] ${type === 'error' ? 'bg-red-950/50 border-red-900' : 'bg-zinc-900 border-zinc-800'
            }`}>
            <div className={type === 'error' ? 'text-red-500' : 'text-emerald-500'}>
                {type === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            </div>
            <span className="text-sm text-zinc-200">{message}</span>
            <button onClick={onClose} className="ml-2 text-zinc-600 hover:text-zinc-400">
                <X size={14} />
            </button>
        </div>
    );
};

// ============================================================
// 开关组件
// ============================================================
const Toggle = ({ enabled, onChange }) => (
    <button
        onClick={(e) => { e.stopPropagation(); onChange(); }}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all duration-200 focus:outline-none ${enabled ? 'bg-emerald-600 shadow-[0_0_10px_rgba(16,185,129,0.3)]' : 'bg-zinc-700'
            }`}
    >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-1'
            }`} />
    </button>
);

// ============================================================
// 真实文件夹浏览器（替代原来的模拟弹窗）
// ============================================================
const FolderBrowser = ({ onClose, onSelect, initialPath }) => {
    const [currentPath, setCurrentPath] = useState(initialPath || 'C:\\');
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);

    // 读取当前目录内容
    const loadDirectory = useCallback(async (dirPath) => {
        setLoading(true);
        try {
            const items = await window.electronAPI.readDir(dirPath);
            setEntries(items);
            setCurrentPath(dirPath);
        } catch (err) {
            console.error('Failed to read directory:', err);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        loadDirectory(currentPath);
    }, []); // 只在初始加载时触发
    // 返回上级目录
    const goUp = () => {
        const parent = currentPath.replace(/\\[^\\]+$/, '') || currentPath.substring(0, 3); // Windows 盘符
        if (parent !== currentPath) {
            loadDirectory(parent);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center animate-fade-in">
            <div className="bg-[#1e1e1e] w-[650px] rounded-xl shadow-2xl border border-zinc-700 overflow-hidden flex flex-col max-h-[520px]">
                {/* 标题栏 */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 bg-[#252526]">
                    <span className="text-sm font-medium text-zinc-200">选择项目文件夹</span>
                    <button onClick={onClose} className="text-zinc-400 hover:text-white">
                        <X size={16} />
                    </button>
                </div>

                {/* 路径工具栏 */}
                <div className="px-4 py-2 border-b border-zinc-700 flex gap-2 items-center bg-[#1e1e1e]">
                    <button
                        onClick={goUp}
                        className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 transition-colors"
                        title="返回上级目录"
                    >
                        <ArrowUp size={16} />
                    </button>
                    <div className="flex-1 bg-[#2b2b2b] border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-300 font-mono truncate">
                        {currentPath}
                    </div>
                </div>

                {/* 文件列表 */}
                <div className="flex-1 overflow-y-auto p-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-8 text-zinc-500 text-sm">
                            正在读取...
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-zinc-500 text-sm">
                            此文件夹为空
                        </div>
                    ) : (
                        entries.map(entry => (
                            <div
                                key={entry.path}
                                onClick={() => {
                                    if (entry.isDirectory) {
                                        loadDirectory(entry.path);
                                    }
                                }}
                                className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer group ${entry.isDirectory
                                    ? 'hover:bg-[#2a2d2e]'
                                    : 'opacity-50 cursor-default'
                                    }`}
                            >
                                {entry.isDirectory ? (
                                    <Folder size={16} className="text-blue-400 flex-shrink-0" />
                                ) : (
                                    <FileCode size={16} className="text-zinc-500 flex-shrink-0" />
                                )}
                                <span className={`text-sm truncate ${entry.isDirectory
                                    ? 'text-zinc-300 group-hover:text-white'
                                    : 'text-zinc-500'
                                    }`}>
                                    {entry.name}
                                </span>
                            </div>
                        ))
                    )}
                </div>

                {/* 底部按钮 */}
                <div className="px-4 py-3 border-t border-zinc-700 bg-[#252526] flex justify-between items-center">
                    <span className="text-xs text-zinc-500 truncate max-w-[350px]">{currentPath}</span>
                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-1.5 rounded text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                        >
                            取消
                        </button>
                        <button
                            onClick={() => {
                                const folderName = currentPath.split('\\').pop() || currentPath;
                                onSelect(folderName, currentPath);
                            }}
                            className="px-4 py-1.5 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium shadow-sm"
                        >
                            选择此文件夹
                        </button>
                    </div>
                </div>
            </div >
        </div >
    );
};

// ============================================================
// 最近项目搜索面板
// ============================================================
const RecentProjectsModal = ({ onClose, onSelect, onOpenInCursor, projects }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [filter, setFilter] = useState('');

    const filteredProjects = projects.filter(p =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.path.toLowerCase().includes(filter.toLowerCase())
    );

    // 键盘导航
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, filteredProjects.length - 1));
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
            }
            if (e.key === 'Enter' && filteredProjects[selectedIndex]) {
                onOpenInCursor(filteredProjects[selectedIndex]);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, filteredProjects, selectedIndex, onOpenInCursor]);

    return (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-[60] flex items-start justify-center pt-[20vh] animate-fade-in">
            <div className="bg-[#1e1e1e] w-[600px] rounded-lg shadow-2xl border border-zinc-700 overflow-hidden flex flex-col animate-slide-in-top">
                <div className="p-3 border-b border-zinc-700/50 flex items-center gap-3">
                    <Search size={18} className="text-zinc-400" />
                    <input
                        autoFocus
                        value={filter}
                        onChange={(e) => { setFilter(e.target.value); setSelectedIndex(0); }}
                        placeholder="搜索最近的项目..."
                        className="bg-transparent border-none outline-none text-zinc-200 text-sm w-full placeholder:text-zinc-500"
                    />
                    <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-xs bg-zinc-800 px-1.5 py-0.5 rounded">Esc</button>
                </div>
                <div className="py-2 min-h-[100px] max-h-[400px] overflow-y-auto">
                    <div className="px-3 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">最近打开</div>

                    {projects.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-8 text-zinc-500 gap-2">
                            <History size={24} className="opacity-20" />
                            <span className="text-xs">还没有打开过任何本地项目</span>
                        </div>
                    ) : filteredProjects.length === 0 ? (
                        <div className="px-4 py-2 text-sm text-zinc-500">没有匹配的项目</div>
                    ) : (
                        filteredProjects.map((project, idx) => (
                            <div
                                key={project.path}
                                onClick={() => onOpenInCursor(project)}
                                onMouseEnter={() => setSelectedIndex(idx)}
                                className={`px-4 py-2.5 flex items-center justify-between cursor-pointer group ${idx === selectedIndex ? 'bg-[#094771] text-white' : 'text-zinc-300 hover:bg-[#2a2d2e]'
                                    }`}
                            >
                                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                                    <span className="text-sm font-medium flex items-center gap-2">
                                        <Folder size={14} className="text-blue-400 flex-shrink-0" />
                                        {project.name}
                                    </span>
                                    <span className={`text-[10px] truncate max-w-[350px] ${idx === selectedIndex ? 'text-zinc-300' : 'text-zinc-500'}`}>
                                        {project.path}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`text-[10px] ${idx === selectedIndex ? 'text-zinc-300' : 'text-zinc-600'}`}>
                                        {new Date(project.lastOpened).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                                    </span>
                                    <ExternalLink size={12} className={`${idx === selectedIndex ? 'text-zinc-300' : 'text-zinc-700'}`} />
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 自定义标题栏（绑定真实窗口控制）
// ============================================================
const TitleBar = () => {
    const [isMaximized, setIsMaximized] = useState(false);

    // 定期检查窗口状态
    useEffect(() => {
        const checkMaximized = async () => {
            if (window.electronAPI) {
                const maximized = await window.electronAPI.isMaximized();
                setIsMaximized(maximized);
            }
        };
        checkMaximized();
        const interval = setInterval(checkMaximized, 500);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="titlebar-drag flex items-center justify-between h-10 px-4 bg-[#0b0b0b] border-b border-zinc-800/50 select-none z-50 relative">
            <div className="flex items-center gap-2 text-zinc-500 text-[11px] font-medium">
                <div className="w-3.5 h-3.5 flex items-center justify-center opacity-80">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
                        <path d="m21 16-9 5-9-5V8l9-5 9 5v8z" />
                        <path d="M12 21v-9" />
                        <path d="m21 8-9 4-9-4" />
                    </svg>
                </div>
                <span className="tracking-tight">Cursor</span>
            </div>

            <div className="titlebar-no-drag flex items-center gap-0">
                <div className="flex items-center gap-1 mr-4 border-r border-zinc-800/50 pr-4">
                    <div className="p-1.5 hover:bg-zinc-800 rounded transition-colors cursor-default text-zinc-500 hover:text-zinc-300">
                        <Layout size={14} />
                    </div>
                </div>
                {/* 最小化 */}
                <div
                    onClick={() => window.electronAPI?.windowMinimize()}
                    className="px-3 h-10 flex items-center hover:bg-zinc-800 transition-colors cursor-default text-zinc-500"
                >
                    <Minus size={14} />
                </div>
                {/* 最大化/还原 */}
                <div
                    onClick={() => window.electronAPI?.windowToggleMaximize()}
                    className="px-3 h-10 flex items-center hover:bg-zinc-800 transition-colors cursor-default text-zinc-500"
                >
                    <Square size={isMaximized ? 10 : 12} />
                </div>
                {/* 关闭 */}
                <div
                    onClick={() => window.electronAPI?.windowClose()}
                    className="px-3 h-10 flex items-center hover:bg-red-600 group transition-colors cursor-default text-zinc-500"
                >
                    <X size={14} className="group-hover:text-white" />
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 首页视图
// ============================================================
const HomeView = ({ onOpenSettings, addToast, recentProjects, onAddRecent, onOpenProject }) => {
    const [showRecentProjects, setShowRecentProjects] = useState(false);
    const [showFolderBrowser, setShowFolderBrowser] = useState(false);

    // 核心功能：打开本地文件夹（使用 Electron 原生对话框）
    const handleOpenLocalFolder = async () => {
        if (!window.electronAPI) {
            addToast('Electron API unavailable. Please run this in desktop app.', 'error');
            return;
        }

        const result = await window.electronAPI.openFolderDialog();
        if (!result) return; // 用户取消了选择

        const projectData = {
            name: result.name,
            path: result.path,
            lastOpened: Date.now(),
        };

        onAddRecent(projectData);
        // 选择文件夹后直接进入项目界面
        onOpenProject(projectData);
    };

    // 从浏览器中选择文件夹后的回调
    const handleBrowserFolderSelect = (name, folderPath) => {
        setShowFolderBrowser(false);
        const projectData = {
            name: name,
            path: folderPath,
            lastOpened: Date.now(),
        };
        onAddRecent(projectData);
        addToast(`已打开项目：${name}`);
    };

    // 打开项目：进入项目界面
    const handleOpenProject = (project) => {
        setShowRecentProjects(false);
        // 更新打开时间
        onAddRecent({ ...project, lastOpened: Date.now() });
        // 切换到项目界面
        onOpenProject({ ...project, lastOpened: Date.now() });
    };

    const handleAction = (label) => {
        if (label === 'New Project') {
            handleOpenLocalFolder();
        } else if (label === 'Browse Folder') {
            setShowFolderBrowser(true);
        } else if (label === 'Load Last Project') {
            setShowRecentProjects(true);
        }
    };

    const actions = [
        { icon: <Plus size={20} />, label: 'New Project', desc: '选择文件夹打开' },
        { icon: <History size={20} />, label: 'Load Last Project', desc: '浏览最近的项目' },
    ];

    return (
        <>
            <div className="flex flex-col items-center justify-center min-h-[calc(100vh-40px)] bg-[#0b0b0b] text-zinc-300 px-6 relative">
                {/* 弹窗层 */}
                {showFolderBrowser && (
                    <FolderBrowser
                        onClose={() => setShowFolderBrowser(false)}
                        onSelect={handleBrowserFolderSelect}
                        initialPath="C:\\"
                    />
                )}
                {showRecentProjects && (
                    <RecentProjectsModal
                        onClose={() => setShowRecentProjects(false)}
                        onSelect={(project) => {
                            setShowRecentProjects(false);
                            onAddRecent({ ...project, lastOpened: Date.now() });
                            addToast(`已选择：${project.name}`);
                        }}
                        onOpenInCursor={handleOpenProject}
                        projects={recentProjects}
                    />
                )}

                {/* Logo 区域 */}
                <div className="mb-14 flex flex-col items-start w-full max-w-[720px] animate-slide-in-top">
                    <div className="flex items-center gap-4 mb-2">
                        <div className="w-12 h-12 flex items-center justify-center">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full text-white">
                                <path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" fill="white" />
                                <path d="M12 22V12L21 7M12 12L3 7" stroke="black" strokeWidth="1.5" strokeLinejoin="round" />
                                <path d="M12 12H12.01" stroke="black" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                        </div>
                        <h1 className="text-[42px] font-black tracking-tight text-white leading-none">CURSOR</h1>
                    </div>

                    <div className="flex items-center gap-1.5 text-sm ml-16 mt-[-4px]">
                        <button
                            onClick={() => addToast("Pro features enabled")}
                            className="text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            Pro
                        </button>
                        <span className="text-zinc-800 text-xs">•</span>
                        <button
                            onClick={onOpenSettings}
                            className="text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            Settings
                        </button>
                    </div>
                </div>

                {/* 操作卡片 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-[720px] mb-16">
                    {actions.map((item, idx) => (
                        <div
                            key={idx}
                            onClick={() => handleAction(item.label)}
                            className="group flex flex-col items-start p-5 bg-[#141414] border border-zinc-800/40 rounded-xl hover:bg-[#1a1a1a] hover:border-zinc-700/60 transition-all duration-200 cursor-pointer active:scale-[0.98]"
                        >
                            <div className="text-zinc-400 group-hover:text-zinc-200 mb-4 transition-colors">
                                {item.icon}
                            </div>
                            <div className="text-[15px] font-medium text-zinc-300 group-hover:text-white transition-colors">
                                {item.label}
                            </div>
                            <div className="text-[11px] text-zinc-600 mt-1">{item.desc}</div>
                        </div>
                    ))}
                </div>

                {/* 最近项目列表 */}
                <div className="w-full max-w-[720px] animate-slide-in-bottom">
                    <div className="flex items-center justify-between mb-4 px-1">
                        <h2 className="text-[11px] font-bold text-zinc-600 uppercase tracking-[0.15em]">Recent projects</h2>
                    </div>
                    <div className="h-[1px] w-full bg-zinc-900" />

                    <div className="mt-4 flex flex-col gap-0.5">
                        {recentProjects.length > 0 ? recentProjects.slice(0, 5).map((proj, i) => (
                            <div
                                key={i}
                                className="group text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer flex items-center justify-between py-2 px-2 rounded hover:bg-zinc-900/50 transition-colors"
                                onClick={() => handleOpenProject(proj)}
                            >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <Folder size={13} className="text-blue-400/60 flex-shrink-0" />
                                    <span className="font-medium">{proj.name}</span>
                                    <span className="text-zinc-700 truncate text-[10px]">{proj.path}</span>
                                </div>
                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            window.electronAPI?.showInExplorer(proj.path);
                                        }}
                                        className="text-zinc-600 hover:text-zinc-300 p-1"
                                        title="在资源管理器中显示"
                                    >
                                        <ExternalLink size={12} />
                                    </button>
                                </div>
                            </div>
                        )) : (
                            <span className="text-xs text-zinc-700 italic mt-2 px-2">还没有打开过项目，点击上方 New Project 开始</span>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
};

// ============================================================
// 设置视图 — 模型管理 + More
// ============================================================
const EMPTY_MODEL = {
    displayName: '', apiKey: '', baseUrl: '', modelName: '',
    sourceType: 'manual', rawSource: '', headers: '{}', extraBody: '{}',
    compressThreshold: '',
};

const SettingsView = ({ onClose }) => {
    const dialog = useDialog();
    const [activeTab, setActiveTab] = useState('Model');
    const [models, setModels] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [form, setForm] = useState({ ...EMPTY_MODEL });
    const [parseMode, setParseMode] = useState(null); // 'curl' | 'python' | null
    const [parseText, setParseText] = useState('');
    const [loading, setLoading] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [workflowDirty, setWorkflowDirty] = useState(false);
    const [autoExecute, setAutoExecute] = useState(false);
    const [agentEngine, setAgentEngine] = useState('v2');
    const [codexProxyPort, setCodexProxyPort] = useState('1455');
    const [codexProxyApiKey, setCodexProxyApiKey] = useState('');
    const [codexProxyStatus, setCodexProxyStatus] = useState({
        status: 'stopped',
        running: false,
        pid: null,
        logs: [],
        lastError: '',
        configuredApiKey: false,
    });
    const [codexProxyBusy, setCodexProxyBusy] = useState(false);
    const [codexImportBusy, setCodexImportBusy] = useState(false);
    const [codexManualBusy, setCodexManualBusy] = useState(false);

    // 加载 Auto 执行 + Agent 引擎配置
    useEffect(() => {
        (async () => {
            const r = await window.electronAPI?.modeConfigGet();
            if (r?.success) {
                setAutoExecute(r.data?.taskExecution?.autoExecute ?? false);
                setAgentEngine(r.data?.agentEngine || 'v2');
                setCodexProxyPort(String(r.data?.codexProxy?.port || 1455));
                setCodexProxyApiKey(r.data?.codexProxy?.apiKey || '');
            }
        })();
    }, []);

    const toggleAutoExecute = useCallback(async (val) => {
        setAutoExecute(val);
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.taskExecution = { ...(cfg.taskExecution || {}), autoExecute: val };
        await window.electronAPI?.modeConfigSave(cfg);
    }, []);

    const toggleAgentEngine = useCallback(async (val) => {
        setAgentEngine(val);
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.agentEngine = val;
        await window.electronAPI?.modeConfigSave(cfg);
    }, []);

    // 加载模型列表
    const loadModels = useCallback(async () => {
        const r = await window.electronAPI?.modelList();
        if (r?.success) setModels(r.data || []);
    }, []);

    useEffect(() => { loadModels(); }, [loadModels]);

    const loadCodexProxyStatus = useCallback(async () => {
        const r = await window.electronAPI?.codexProxyStatus?.();
        if (r?.success) {
            const statusData = r.data || {};
            setCodexProxyStatus(statusData);
            const statusPort = Number(statusData?.port);
            const shouldSyncPort = statusData?.status && statusData.status !== 'stopped';
            if (shouldSyncPort && Number.isFinite(statusPort) && statusPort > 0) {
                setCodexProxyPort(String(statusPort));
            }
        }
    }, []);

    useEffect(() => {
        loadCodexProxyStatus();
        const timer = setInterval(loadCodexProxyStatus, 3000);
        return () => clearInterval(timer);
    }, [loadCodexProxyStatus]);

    const persistCodexProxyConfig = useCallback(async (port, apiKey) => {
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.codexProxy = {
            ...(cfg.codexProxy || {}),
            port: Number(port) > 0 ? Number(port) : 1455,
            apiKey: apiKey || '',
        };
        await window.electronAPI?.modeConfigSave(cfg);
    }, []);

    const handleStartCodexProxy = useCallback(async () => {
        setCodexProxyBusy(true);
        await persistCodexProxyConfig(codexProxyPort, codexProxyApiKey);
        const r = await window.electronAPI?.codexProxyStart?.({
            port: Number(codexProxyPort) > 0 ? Number(codexProxyPort) : 1455,
            apiKey: codexProxyApiKey || '',
            openBrowser: true,
        });
        await loadCodexProxyStatus();
        setCodexProxyBusy(false);
        if (!r?.success) await dialog.alert('Start service failed: ' + (r?.error || 'unknown error'));
    }, [codexProxyPort, codexProxyApiKey, persistCodexProxyConfig, loadCodexProxyStatus, dialog]);

    const handleOpenCodexProxyPage = useCallback(async () => {
        const statusPort = Number(codexProxyStatus?.port);
        const inputPort = Number(codexProxyPort);
        const port = Number.isFinite(statusPort) && statusPort > 0
            ? statusPort
            : (Number.isFinite(inputPort) && inputPort > 0 ? inputPort : 1455);
        const r = await window.electronAPI?.codexProxyOpen?.({ port });
        if (!r?.success) await dialog.alert('Open service page failed: ' + (r?.error || 'unknown error'));
    }, [codexProxyStatus, codexProxyPort, dialog]);

    const handleStopCodexProxy = useCallback(async () => {
        setCodexProxyBusy(true);
        const r = await window.electronAPI?.codexProxyStop?.();
        await loadCodexProxyStatus();
        setCodexProxyBusy(false);
        if (!r?.success) await dialog.alert('Stop service failed: ' + (r?.error || 'unknown error'));
    }, [loadCodexProxyStatus, dialog]);

    const handleImportCodexModels = useCallback(async () => {
        setCodexImportBusy(true);
        await persistCodexProxyConfig(codexProxyPort, codexProxyApiKey);
        const port = Number(codexProxyPort) > 0 ? Number(codexProxyPort) : 1455;
        const r = await window.electronAPI?.codexProxyImportModels?.({
            port,
            apiKey: codexProxyApiKey || '',
            baseUrl: `http://127.0.0.1:${port}`,
        });
        setCodexImportBusy(false);
        if (r?.success) {
            await loadModels();
            await dialog.alert(
                `Import completed: ${r.data?.total || 0} models\nCreated ${r.data?.created || 0}, Updated ${r.data?.updated || 0}\nSource: ${r.data?.source || 'unknown'}`
            );
        } else {
            await dialog.alert('Import failed: ' + (r?.error || 'unknown error'));
        }
    }, [codexProxyPort, codexProxyApiKey, persistCodexProxyConfig, loadModels, dialog]);

    const handleCheckCodexAuthDebug = useCallback(async () => {
        const r = await window.electronAPI?.codexProxyGetAuthDebug?.();
        if (!r?.success) {
            const code = r?.code || '';
            const status = r?.data?.status || codexProxyStatus?.status || 'stopped';
            const ports = Array.isArray(r?.data?.candidatePorts) ? r.data.candidatePorts.join(', ') : (codexProxyPort || '1455');
            if (code === 'SERVICE_NOT_RUNNING') {
                await dialog.alert(
                    `OAuth 诊断失败：服务未运行（status=${status}）。\n请先点击“启动服务”，然后再点“OAuth诊断”。\n当前诊断端口：${ports}\n\n详情：${r?.error || 'unknown error'}`
                );
            } else {
                await dialog.alert(
                    `OAuth 诊断失败：无法连接 /auth/debug。\n请确认服务已启动且端口可访问（${ports}）。\n\n详情：${r?.error || 'unknown error'}`
                );
            }
            return;
        }
        const d = r.data || {};
        const msg = [
            `debugUrl: ${d?._debugUrl || '-'}`,
            `computedRedirectUri: ${d?.computedRedirectUri || '-'}`,
            `effective.client_id: ${d?.oauthConfig?.OAUTH_CLIENT_ID || '-'}`,
            `effective.prompt: ${d?.oauthConfig?.OAUTH_PROMPT || '-'}`,
            `effective.originator: ${d?.oauthConfig?.OAUTH_ORIGINATOR || '-'}`,
            `effective.simplified_flow: ${String(d?.oauthConfig?.OAUTH_SIMPLIFIED_FLOW ?? '-')}`,
            `effective.id_token_add_orgs: ${String(d?.oauthConfig?.OAUTH_ID_TOKEN_ADD_ORGS ?? '-')}`,
            `effective.allowed_workspace_id: ${d?.oauthConfig?.OAUTH_ALLOWED_WORKSPACE_ID || '-'}`,
            `env.OAUTH_REDIRECT_URI: ${d?.env?.OAUTH_REDIRECT_URI || '-'}`,
            `env.OAUTH_CLIENT_ID: ${d?.env?.OAUTH_CLIENT_ID || '-'}`,
            `env.OAUTH_PROMPT: ${d?.env?.OAUTH_PROMPT || '-'}`,
            `env.OAUTH_ORIGINATOR: ${d?.env?.OAUTH_ORIGINATOR || '-'}`,
            `env.OAUTH_SIMPLIFIED_FLOW: ${d?.env?.OAUTH_SIMPLIFIED_FLOW || '-'}`,
            `env.OAUTH_ID_TOKEN_ADD_ORGS: ${d?.env?.OAUTH_ID_TOKEN_ADD_ORGS || '-'}`,
            `env.OAUTH_ALLOWED_WORKSPACE_ID: ${d?.env?.OAUTH_ALLOWED_WORKSPACE_ID || '-'}`,
            `env.PUBLIC_URL: ${d?.env?.PUBLIC_URL || '-'}`,
            `env.PORT/runtimePort: ${d?.env?.PORT || '-'} / ${d?.env?.runtimePort || '-'}`,
            `request.host: ${d?.request?.host || '-'}`,
            `request.xForwardedHost: ${d?.request?.xForwardedHost || '-'}`,
            `request.xForwardedProto: ${d?.request?.xForwardedProto || '-'}`,
        ].join('\n');
        await dialog.alert(msg, 'OAuth 诊断');
    }, [dialog, codexProxyStatus, codexProxyPort]);

    const handleManualImportCodexAccount = useCallback(async () => {
        const raw = await dialog.prompt(
            '粘贴 auth.json 内容，或按两行输入：\n第1行 access_token\n第2行 account_id',
            '',
            '手动导入账号'
        );
        if (!raw) return;

        const text = String(raw).trim();
        if (!text) return;

        let body = null;
        if (text.startsWith('{')) {
            try {
                JSON.parse(text);
            } catch (e) {
                await dialog.alert('auth.json 解析失败: ' + e.message);
                return;
            }
            body = { authJson: text, source: 'manual' };
        } else {
            const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (lines.length < 2) {
                await dialog.alert('输入格式错误：请提供两行（access_token 与 account_id）');
                return;
            }
            body = {
                access_token: lines[0],
                account_id: lines[1],
                source: 'manual',
            };
        }

        setCodexManualBusy(true);
        const r = await window.electronAPI?.codexProxyAddAccountManual?.(body);
        setCodexManualBusy(false);

        if (!r?.success) {
            await dialog.alert('Manual import failed: ' + (r?.error || 'unknown error'));
            return;
        }
        await loadCodexProxyStatus();
        await dialog.alert('账号导入成功。请在服务页 Accounts 中确认。');
    }, [dialog, loadCodexProxyStatus]);

    // 选中模型
    const selectModel = (m) => {
        setSelectedId(m.id);
        setForm({
            displayName: m.displayName || '',
            apiKey: m.apiKey || '',
            baseUrl: m.baseUrl || '',
            modelName: m.modelName || '',
            sourceType: m.sourceType || 'manual',
            rawSource: m.rawSource || '',
            headers: typeof m.headers === 'string' ? m.headers : JSON.stringify(m.headers || {}, null, 2),
            extraBody: typeof m.extraBody === 'string' ? m.extraBody : JSON.stringify(m.extraBody || {}, null, 2),
            compressThreshold: m.compressThreshold ?? '',
        });
        setDirty(false);
        setParseMode(null);
    };

    // 新建模型
    const handleNew = () => {
        setSelectedId(null);
        setForm({ ...EMPTY_MODEL });
        setDirty(true);
        setParseMode(null);
    };

    // 保存模型
    const handleSave = async () => {
        if (!form.displayName.trim()) { await dialog.alert('显示名称不能为空'); return; }
        setLoading(true);
        let headersObj = {}, extraBodyObj = {};
        try { headersObj = JSON.parse(form.headers || '{}'); } catch (_) { await dialog.alert('请求头 JSON 格式错误'); setLoading(false); return; }
        try { extraBodyObj = JSON.parse(form.extraBody || '{}'); } catch (_) { await dialog.alert('额外请求体 JSON 格式错误'); setLoading(false); return; }
        const payload = { ...form, headers: headersObj, extraBody: extraBodyObj };
        let r;
        if (selectedId) {
            r = await window.electronAPI?.modelUpdate(selectedId, payload);
        } else {
            r = await window.electronAPI?.modelCreate(payload);
        }
        if (r?.success) {
            await loadModels();
            if (!selectedId && r.data?.id) setSelectedId(r.data.id);
            setDirty(false);
        } else {
            await dialog.alert('保存失败: ' + (r?.error || '未知错误'));
        }
        setLoading(false);
    };

    // 删除
    const handleDelete = async () => {
        if (!selectedId) return;
        if (!(await dialog.confirm('确定要删除这个模型配置？'))) return;
        const r = await window.electronAPI?.modelDelete(selectedId);
        if (r?.success) {
            setSelectedId(null);
            setForm({ ...EMPTY_MODEL });
            setDirty(false);
            await loadModels();
        } else {
            await dialog.alert('删除失败: ' + (r?.error || '未知错误'));
        }
    };

    // 复制
    const handleDuplicate = async () => {
        if (!selectedId) return;
        const r = await window.electronAPI?.modelDuplicate(selectedId);
        if (r?.success) {
            await loadModels();
            if (r.data) selectModel(r.data);
        } else {
            await dialog.alert('复制失败: ' + (r?.error || '未知错误'));
        }
    };

    // 解析 cURL/Python
    const handleParse = async () => {
        if (!parseText.trim()) return;
        const r = await window.electronAPI?.modelParse(parseText, parseMode);
        if (r?.success && r.data) {
            setForm(prev => ({
                ...prev,
                baseUrl: r.data.baseUrl || prev.baseUrl,
                apiKey: r.data.apiKey || prev.apiKey,
                modelName: r.data.modelName || prev.modelName,
                sourceType: parseMode,
                rawSource: parseText,
                headers: Object.keys(r.data.headers || {}).length > 0 ? JSON.stringify(r.data.headers, null, 2) : prev.headers,
                extraBody: Object.keys(r.data.extraBody || {}).length > 0 ? JSON.stringify(r.data.extraBody, null, 2) : prev.extraBody,
            }));
            setDirty(true);
            setParseMode(null);
            setParseText('');
        } else {
            await dialog.alert('解析失败: ' + (r?.error || '未能提取字段'));
        }
    };

    const updateField = (key, val) => {
        setForm(prev => ({ ...prev, [key]: val }));
        setDirty(true);
    };

    const InputRow = ({ label, field, type = 'text', mono = false }) => (
        <div className="flex flex-col gap-1">
            <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">{label}</label>
            <input
                className={`bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600 transition-colors ${mono ? 'font-mono' : ''}`}
                type={type}
                value={form[field]}
                onChange={(e) => updateField(field, e.target.value)}
                spellCheck={false}
            />
        </div>
    );

    const menuItems = [
        { id: 'Model', label: 'Model', icon: <Bot size={16} /> },
        { id: 'Skills', label: 'SKILL 技能', icon: <Wand2 size={16} /> },
        { id: 'Workflow', label: '工作流', icon: <GitBranch size={16} /> },
        { id: 'Evaluation', label: '效果评测', icon: <FlaskConical size={16} /> },
        { id: 'TaskExecution', label: '任务执行', icon: <Zap size={16} /> },
        { id: 'WebSearch', label: '联网搜索', icon: <Globe size={16} /> },
        { id: 'AgentAdvanced', label: 'Agent 高级', icon: <Brain size={16} /> },
        { id: 'GeminiProxy', label: 'Gemini 逆向', icon: <Sparkles size={16} /> },
        { id: 'TokenDashboard', label: 'Token 看板', icon: <BarChart3 size={16} /> },
        { id: 'Version', label: '版本管理', icon: <RotateCcw size={16} /> },
        { id: 'SelfImprove', label: '自我迭代', icon: <RefreshCw size={16} /> },
    ];

    // 关闭设置前检查未保存
    const handleClose = useCallback(async () => {
        if (workflowDirty) {
            const yes = await dialog.confirm('工作流有未保存的修改，确定要离开吗？');
            if (!yes) return;
        }
        onClose();
    }, [workflowDirty, onClose, dialog]);

    return (
        <div className="fixed inset-0 top-10 bg-[#0b0b0b] z-50 flex animate-fade-in">
            {/* 左侧菜单 */}
            <div className="w-52 border-r border-zinc-900 p-4 flex flex-col bg-[#0d0d0d]">
                <div className="flex items-center justify-between mb-8 px-2">
                    <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">设置</span>
                    <button onClick={handleClose} className="p-1 hover:bg-zinc-800 rounded transition-colors text-zinc-600 hover:text-zinc-200">
                        <X size={14} />
                    </button>
                </div>
                <nav className="flex-1 min-h-0 overflow-y-auto space-y-1">
                    {menuItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveTab(item.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-all ${activeTab === item.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'
                                }`}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    ))}
                </nav>
            </div>

            {/* 右侧内容 */}
            <div className="flex-1 flex overflow-hidden">
                {activeTab === 'Model' && (
                    <>
                        {/* 模型列表 */}
                        <div className="w-56 border-r border-zinc-900 flex flex-col bg-[#0c0c0c]">
                            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-900">
                                <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">模型列表</span>
                                <button onClick={handleNew} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-200 transition-colors">
                                    <PlusCircle size={14} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {models.length === 0 && (
                                    <div className="px-3 py-8 text-center text-[10px] text-zinc-600">
                                        尚未配置模型。
                                        <br />点击 + 添加一个。
                                    </div>
                                )}
                                {models.map(m => (
                                    <div
                                        key={m.id}
                                        className={`px-3 py-2 cursor-pointer text-xs border-b border-zinc-900/50 transition-colors ${selectedId === m.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900/50'
                                            }`}
                                        onClick={() => selectModel(m)}
                                    >
                                        <div className="font-medium truncate">{m.displayName}</div>
                                        {m.modelName && !m.displayName?.toLowerCase().includes(m.modelName?.toLowerCase()) && (
                                            <div className="text-[10px] text-zinc-600 truncate mt-0.5">{m.modelName}</div>
                                        )}
                                        {(!m.modelName || m.displayName?.toLowerCase().includes(m.modelName?.toLowerCase())) && m.baseUrl && (
                                            <div className="text-[10px] text-zinc-600 truncate mt-0.5">{m.baseUrl}</div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 编辑表单 */}
                        <div className="flex-1 overflow-y-auto p-8 bg-[#0b0b0b]">
                            <div className="max-w-lg space-y-5">
                                {/* Codex 反代服务 */}
                                <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-sm font-semibold text-zinc-200">Codex 反代服务</div>
                                            <p className="text-[10px] text-zinc-500 mt-0.5">
                                                管理 {`codexProapi-main`} 后台服务，并一键导入全部可用模型
                                            </p>
                                        </div>
                                        <span className={`px-2 py-0.5 rounded text-[10px] border ${codexProxyStatus?.running
                                            ? 'text-emerald-300 border-emerald-700/60 bg-emerald-900/30'
                                            : codexProxyStatus?.status === 'starting' || codexProxyStatus?.status === 'stopping'
                                                ? 'text-amber-300 border-amber-700/60 bg-amber-900/30'
                                                : codexProxyStatus?.status === 'failed'
                                                    ? 'text-red-300 border-red-700/60 bg-red-900/30'
                                                    : 'text-zinc-400 border-zinc-700/60 bg-zinc-900/50'
                                            }`}>
                                            {codexProxyStatus?.status || 'stopped'}
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="flex flex-col gap-1">
                                            <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">Port</label>
                                            <input
                                                className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600 transition-colors font-mono"
                                                value={codexProxyPort}
                                                onChange={(e) => setCodexProxyPort(e.target.value.replace(/[^\d]/g, ''))}
                                                placeholder="1455"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">API Key (Optional)</label>
                                            <input
                                                className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-600 transition-colors font-mono"
                                                type="password"
                                                value={codexProxyApiKey}
                                                onChange={(e) => setCodexProxyApiKey(e.target.value)}
                                                placeholder="代理服务访问密钥（可选）"
                                            />
                                        </div>
                                    </div>

                                    <div className="text-[10px] text-zinc-600 font-mono">
                                        Base URL: {`http://127.0.0.1:${Number(codexProxyPort) > 0 ? Number(codexProxyPort) : 1455}`}
                                        {codexProxyStatus?.pid ? `  路  PID ${codexProxyStatus.pid}` : ''}
                                    </div>

                                    {codexProxyStatus?.lastError && (
                                        <div className="text-[10px] text-red-300 bg-red-950/20 border border-red-900/40 rounded px-2 py-1">
                                            {codexProxyStatus.lastError}
                                        </div>
                                    )}

                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            onClick={handleStartCodexProxy}
                                            disabled={codexProxyBusy || codexProxyStatus?.running || codexProxyStatus?.status === 'starting'}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                                        >
                                            {codexProxyBusy ? '处理中...' : '启动服务'}
                                        </button>
                                        <button
                                            onClick={handleStopCodexProxy}
                                            disabled={codexProxyBusy || (!codexProxyStatus?.running && codexProxyStatus?.status !== 'starting')}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-900 disabled:text-zinc-700 text-zinc-100 transition-colors"
                                        >
                                            停止服务
                                        </button>
                                        <button
                                            onClick={handleOpenCodexProxyPage}
                                            disabled={codexProxyBusy}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-700 text-zinc-100 transition-colors"
                                        >
                                            打开服务页
                                        </button>
                                        <button
                                            onClick={handleImportCodexModels}
                                            disabled={codexImportBusy}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                                        >
                                            {codexImportBusy ? '导入中...' : '导入全部模型'}
                                        </button>
                                        <button
                                            onClick={handleCheckCodexAuthDebug}
                                            disabled={codexProxyBusy}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-700 text-zinc-100 transition-colors"
                                        >
                                            OAuth诊断
                                        </button>
                                        <button
                                            onClick={handleManualImportCodexAccount}
                                            disabled={codexManualBusy}
                                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                                        >
                                            {codexManualBusy ? '导入账号中...' : '手动导入账号'}
                                        </button>
                                    </div>

                                    {Array.isArray(codexProxyStatus?.logs) && codexProxyStatus.logs.length > 0 && (
                                        <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-2 max-h-24 overflow-y-auto custom-scrollbar">
                                            {codexProxyStatus.logs.slice(-5).map((log, idx) => (
                                                <div key={idx} className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                                                    {log?.line}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* 标题 + 操作按钮 */}
                                <div className="flex items-center justify-between">
                                    <h2 className="text-lg font-bold text-zinc-100">
                                        {selectedId ? '编辑模型' : '新建模型'}
                                    </h2>
                                    <div className="flex items-center gap-1">
                                        {selectedId && (
                                            <>
                                                <button onClick={handleDuplicate} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-200 transition-colors" title="复制">
                                                    <Copy size={14} />
                                                </button>
                                                <button onClick={handleDelete} className="p-1.5 hover:bg-red-900/50 rounded text-zinc-500 hover:text-red-400 transition-colors" title="删除">
                                                    <Trash2 size={14} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Parse 区域 */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { setParseMode(parseMode === 'curl' ? null : 'curl'); setParseText(''); }}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${parseMode === 'curl' ? 'bg-zinc-800 text-zinc-100 border-zinc-700' : 'bg-zinc-900/40 text-zinc-500 border-zinc-800/60 hover:text-zinc-300'
                                            }`}
                                    >
                                        <Terminal size={12} /> 通过 cURL 解析
                                    </button>
                                    <button
                                        onClick={() => { setParseMode(parseMode === 'python' ? null : 'python'); setParseText(''); }}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${parseMode === 'python' ? 'bg-zinc-800 text-zinc-100 border-zinc-700' : 'bg-zinc-900/40 text-zinc-500 border-zinc-800/60 hover:text-zinc-300'
                                            }`}
                                    >
                                        <Code2 size={12} /> 通过 Python 解析
                                    </button>
                                </div>

                                {/* Parse 输入区 */}
                                {parseMode && (
                                    <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-3 space-y-2">
                                        <textarea
                                            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-zinc-600 resize-none h-28"
                                            placeholder={parseMode === 'curl' ? '在此粘贴 cURL 命令...' : '在此粘贴 Python 代码...'}
                                            value={parseText}
                                            onChange={(e) => setParseText(e.target.value)}
                                            spellCheck={false}
                                        />
                                        <div className="flex justify-end">
                                            <button
                                                onClick={handleParse}
                                                disabled={!parseText.trim()}
                                                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-medium rounded-lg transition-colors"
                                            >
                                                解析并填充                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* 编辑字段 */}
                                <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-4 space-y-4">
                                    <InputRow label="显示名称" field="displayName" />
                                    <InputRow label="API Key" field="apiKey" type="password" mono />
                                    <InputRow label="Base URL" field="baseUrl" mono />
                                    <InputRow label="Model Name" field="modelName" mono />
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">请求头 (JSON)</label>
                                        <textarea
                                            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-zinc-600 resize-none h-20"
                                            value={form.headers}
                                            onChange={(e) => updateField('headers', e.target.value)}
                                            spellCheck={false}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">额外请求体 (JSON)</label>
                                        <textarea
                                            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-zinc-600 resize-none h-20"
                                            value={form.extraBody}
                                            onChange={(e) => updateField('extraBody', e.target.value)}
                                            spellCheck={false}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">上下文压缩阈值（独立）</label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number" min="0" max="95" step="5"
                                                className="w-20 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-zinc-600"
                                                value={form.compressThreshold}
                                                onChange={(e) => updateField('compressThreshold', e.target.value === '' ? '' : Number(e.target.value))}
                                                placeholder="—"
                                            />
                                            <span className="text-[10px] text-zinc-600">%（留空则使用通用设置值）</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider font-bold">原始文本</label>
                                        <textarea
                                            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300 font-mono outline-none focus:border-zinc-600 resize-none h-16 text-opacity-60"
                                            value={form.rawSource}
                                            onChange={(e) => updateField('rawSource', e.target.value)}
                                            placeholder="原始 cURL/Python 文本（解析器自动填充）"
                                            spellCheck={false}
                                        />
                                    </div>
                                </div>

                                {/* 保存按钮 */}
                                <button
                                    onClick={handleSave}
                                    disabled={loading || !dirty}
                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium rounded-xl transition-colors"
                                >
                                    <Save size={14} /> {loading ? '保存中...' : '保存模型'}
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {activeTab === 'Workflow' && (
                    <div className="flex-1 min-w-0 h-full">
                        <WorkflowPanel models={models} onDirtyChange={setWorkflowDirty} />
                    </div>
                )}

                {activeTab === 'Evaluation' && (
                    <div className="flex-1 min-w-0 h-full">
                        <WorkflowBattlePanel models={models} />
                    </div>
                )}

                {activeTab === 'TaskExecution' && (
                    <div className="flex-1 p-12">
                        <div className="max-w-lg space-y-6">
                            <h2 className="text-lg font-bold text-zinc-100">任务执行配置</h2>
                            <p className="text-xs text-zinc-500">控制 Agent 模式下步骤的执行方式。</p>

                            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-sm font-medium text-zinc-200 flex items-center gap-2">
                                            <Zap size={14} className="text-amber-400" />
                                            Auto 自动执行
                                        </div>
                                        <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                                            开启后，Agent 模式下所有文件写入和命令步骤将自动执行，<br />
                                            无需逐步手动确认。关闭则保留手动 Accept / Reject 流程。                                        </p>
                                    </div>
                                    <button
                                        onClick={() => toggleAutoExecute(!autoExecute)}
                                        className={`relative w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0 ${autoExecute ? 'bg-blue-600' : 'bg-zinc-700'
                                            }`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${autoExecute ? 'translate-x-5' : 'translate-x-0'
                                            }`} />
                                    </button>
                                </div>

                                {autoExecute && (
                                    <div className="bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2 text-[10px] text-amber-300 flex items-start gap-2">
                                        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                                        <span>自动执行已开启，Agent 回复中的文件修改会立即写入磁盘，请确认你信任当前 AI 输出。</span>
                                    </div>
                                )}

                                {/* Agent 引擎模式 */}
                                <div className="flex items-center justify-between mt-4 pt-4 border-t border-zinc-800">
                                    <div className="flex-1 mr-4">
                                        <div className="text-xs text-zinc-200 font-medium">Agent 引擎</div>
                                        <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">
                                            v2 = Tool Calls 闭环（推荐）；v1 = Markdown 解析（兼容旧模型）                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1 bg-zinc-800 rounded-lg p-0.5">
                                        <button
                                            onClick={() => toggleAgentEngine('v1')}
                                            className={`px-3 py-1 text-[10px] rounded-md transition-colors ${agentEngine === 'v1' ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                                        >v1</button>
                                        <button
                                            onClick={() => toggleAgentEngine('v2')}
                                            className={`px-3 py-1 text-[10px] rounded-md transition-colors ${agentEngine === 'v2' ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                                        >v2</button>
                                    </div>
                                </div>
                            </div>

                            <p className="text-[10px] text-zinc-600">配置会持久化保存，重启应用后依然生效。</p>
                        </div>
                    </div>
                )}

                {activeTab === 'WebSearch' && (
                    <WebSearchSettingsPanel />
                )}

                {activeTab === 'AgentAdvanced' && (
                    <AgentAdvancedSettingsPanel />
                )}

                {activeTab === 'GeminiProxy' && (
                    <GeminiProxySettingsPanel onModelsChanged={loadModels} />
                )}

                {activeTab === 'Skills' && (
                    <SkillsSettingsPanel dialog={dialog} />
                )}

                {activeTab === 'TokenDashboard' && (
                    <TokenDashboard />
                )}

                {activeTab === 'Version' && (
                    <VersionSettingsPanel dialog={dialog} />
                )}

                {activeTab === 'SelfImprove' && (
                    <SuggestionsSettingsPanel dialog={dialog} />
                )}
            </div>
        </div >
    );
};

// ============================================================
// 联网搜索设置面板
// ============================================================
const WebSearchSettingsPanel = () => {
    const [webSearchEnabled, setWebSearchEnabled] = useState(false);
    const [searxngUrl, setSearxngUrl] = useState('');
    const [googleApiKey, setGoogleApiKey] = useState('');
    const [googleCx, setGoogleCx] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            const r = await window.electronAPI?.modeConfigGet();
            if (r?.success) {
                const cfg = r.data || {};
                setWebSearchEnabled(cfg.webSearch?.enabled ?? false);
                setSearxngUrl(cfg.webSearch?.searxngUrl || '');
                setGoogleApiKey(cfg.webSearch?.googleApiKey || '');
                setGoogleCx(cfg.webSearch?.googleCx || '');
            }
        })();
    }, []);

    const handleSave = async () => {
        setSaving(true);
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.webSearch = { enabled: webSearchEnabled, searxngUrl, googleApiKey, googleCx };
        await window.electronAPI?.modeConfigSave(cfg);
        setSaving(false);
    };

    const inputClass = "w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-600 transition-colors";
    const labelClass = "text-[11px] text-zinc-400 mb-1 block";

    return (
        <div className="flex-1 p-12 overflow-y-auto">
            <h2 className="text-lg font-bold text-zinc-100 mb-2">联网搜索</h2>
            <p className="text-[11px] text-zinc-500 mb-6">允许 Agent 搜索互联网获取最新信息、文档和解决方案。</p>

            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-sm font-semibold text-zinc-200">启用联网搜索</h3>
                        <p className="text-[10px] text-zinc-500 mt-0.5">开启后可在对话输入框左下角快速切换</p>
                    </div>
                    <button
                        onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                        className={`relative w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0 ${webSearchEnabled ? 'bg-blue-600' : 'bg-zinc-700'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${webSearchEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>
                {webSearchEnabled && (
                    <div className="space-y-3 mt-3 pt-3 border-t border-zinc-800">
                        <div>
                            <label className={labelClass}>SearXNG 实例地址（可选，自托管搜索引擎）</label>
                            <input value={searxngUrl} onChange={e => setSearxngUrl(e.target.value)} placeholder="https://searx.example.com" className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>Google Custom Search API Key（可选）</label>
                            <input value={googleApiKey} onChange={e => setGoogleApiKey(e.target.value)} placeholder="AIzaSy..." type="password" className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>Google Custom Search Engine ID（可选）</label>
                            <input value={googleCx} onChange={e => setGoogleCx(e.target.value)} placeholder="0123456789:abcdefg" className={inputClass} />
                        </div>
                        <p className="text-[10px] text-zinc-600">未配置搜索源时，将使用内置搜索引擎（SearXNG 公共实例 → DuckDuckGo 降级）。</p>
                    </div>
                )}
            </div>

            <button onClick={handleSave} disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
                {saving ? '保存中...' : '保存配置'}
            </button>
        </div>
    );
};

// ============================================================
// Agent 高级设置面板
// ============================================================
const AgentAdvancedSettingsPanel = () => {
    const [evalPassScore, setEvalPassScore] = useState(75);
    const [compressThreshold, setCompressThreshold] = useState(60);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            const r = await window.electronAPI?.modeConfigGet();
            if (r?.success) {
                const cfg = r.data || {};
                setEvalPassScore(cfg.agent?.evalPassScore ?? 75);
                setCompressThreshold(cfg.agent?.compressThreshold ?? 60);
            }
        })();
    }, []);

    const handleSave = async () => {
        setSaving(true);
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.agent = { ...(cfg.agent || {}), evalPassScore, compressThreshold };
        await window.electronAPI?.modeConfigSave(cfg);
        setSaving(false);
    };

    const labelClass = "text-[11px] text-zinc-400 mb-1 block";

    return (
        <div className="flex-1 p-12 overflow-y-auto">
            <h2 className="text-lg font-bold text-zinc-100 mb-2">Agent 高级设置</h2>
            <p className="text-[11px] text-zinc-500 mb-6">调整 Agent 执行行为的关键参数。单个模型可在 Model 页面单独覆盖通用值。</p>

            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5 mb-6">
                <div className="space-y-5">
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className={labelClass} style={{ marginBottom: 0 }}>方案评估合格分数线</label>
                            <span className="text-xs font-mono text-blue-400">{evalPassScore}/100</span>
                        </div>
                        <input type="range" min="50" max="95" step="5" value={evalPassScore}
                            onChange={e => setEvalPassScore(Number(e.target.value))}
                            className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                        <div className="flex justify-between text-[9px] text-zinc-600 mt-1">
                            <span>50（宽松）</span><span>75（推荐）</span><span>95（严格）</span>
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
                            Agent 制定计划后会进行 10 维度自评。总分低于此值时，Agent 将自动优化计划后重新评估，直到达标才执行。
                        </p>
                    </div>
                    <div className="border-t border-zinc-800 pt-4">
                        <div className="flex items-center justify-between mb-1.5">
                            <label className={labelClass} style={{ marginBottom: 0 }}>上下文压缩阈值（通用）</label>
                            <span className="text-xs font-mono text-blue-400">{compressThreshold}%</span>
                        </div>
                        <input type="range" min="40" max="90" step="5" value={compressThreshold}
                            onChange={e => setCompressThreshold(Number(e.target.value))}
                            className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                        <div className="flex justify-between text-[9px] text-zinc-600 mt-1">
                            <span>40%（激进压缩）</span><span>60%（推荐）</span><span>90%（保守）</span>
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
                            当 token 用量达到此百分比时自动压缩历史消息。若在 Model 页面为某模型单独设置了值，单独值优先。
                            值越低压缩越频繁（适合 Codex 等短上下文模型）；值越高保留越多（适合大上下文模型）。
                        </p>
                    </div>
                </div>
            </div>

            <button onClick={handleSave} disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
                {saving ? '保存中...' : '保存配置'}
            </button>
        </div>
    );
};

// ============================================================
// Gemini 逆向代理设置面板
// ============================================================
const GeminiProxySettingsPanel = ({ onModelsChanged }) => {
    const dialog = useDialog();
    const [port, setPort] = useState('8000');
    const [apiKey, setApiKey] = useState('sk-geminixxxxx');
    const [adminUsername, setAdminUsername] = useState('admin');
    const [adminPassword, setAdminPassword] = useState('admin123');
    const [status, setStatus] = useState({ status: 'stopped', running: false, pid: null, logs: [], lastError: '' });
    const [busy, setBusy] = useState(false);
    const [importBusy, setImportBusy] = useState(false);
    const [saving, setSaving] = useState(false);

    const loadStatus = useCallback(async () => {
        const r = await window.electronAPI?.geminiProxyStatus?.();
        if (r?.success) {
            setStatus(r.data || {});
            const sPort = Number(r.data?.port);
            if (r.data?.status && r.data.status !== 'stopped' && Number.isFinite(sPort) && sPort > 0) {
                setPort(String(sPort));
            }
        }
    }, []);

    useEffect(() => {
        (async () => {
            const r = await window.electronAPI?.modeConfigGet();
            if (r?.success) {
                const gp = r.data?.geminiProxy || {};
                setPort(String(gp.port || 8000));
                setApiKey(gp.apiKey || 'sk-geminixxxxx');
                setAdminUsername(gp.adminUsername || 'admin');
                setAdminPassword(gp.adminPassword || 'admin123');
            }
        })();
        loadStatus();
        const timer = setInterval(loadStatus, 3000);
        return () => clearInterval(timer);
    }, [loadStatus]);

    const handleSaveConfig = async () => {
        setSaving(true);
        const r = await window.electronAPI?.modeConfigGet();
        const cfg = r?.success ? r.data : {};
        cfg.geminiProxy = {
            ...(cfg.geminiProxy || {}),
            port: Number(port) > 0 ? Number(port) : 8000,
            apiKey: apiKey || '',
            adminUsername: adminUsername || 'admin',
            adminPassword: adminPassword || 'admin123',
        };
        await window.electronAPI?.modeConfigSave(cfg);
        setSaving(false);
    };

    const handleStart = async () => {
        setBusy(true);
        await handleSaveConfig();
        const r = await window.electronAPI?.geminiProxyStart?.({
            port: Number(port) > 0 ? Number(port) : 8000,
            apiKey: apiKey || '',
            adminUsername: adminUsername || 'admin',
            adminPassword: adminPassword || 'admin123',
        });
        await loadStatus();
        setBusy(false);
        if (!r?.success) await dialog.alert('启动失败: ' + (r?.error || '未知错误'));
    };

    const handleStop = async () => {
        setBusy(true);
        const r = await window.electronAPI?.geminiProxyStop?.();
        await loadStatus();
        setBusy(false);
        if (!r?.success) await dialog.alert('停止失败: ' + (r?.error || '未知错误'));
    };

    const handleOpenAdmin = async () => {
        const sPort = Number(status?.port) || Number(port) || 8000;
        const r = await window.electronAPI?.geminiProxyOpenAdmin?.({ port: sPort, username: adminUsername, password: adminPassword });
        if (!r?.success) await dialog.alert('打开后台失败: ' + (r?.error || '未知错误'));
    };

    const handleImportModels = async () => {
        setImportBusy(true);
        await handleSaveConfig();
        const sPort = Number(status?.port) || Number(port) || 8000;
        const r = await window.electronAPI?.geminiProxyImportModels?.({
            port: sPort,
            apiKey: apiKey || '',
            baseUrl: `http://127.0.0.1:${sPort}`,
        });
        setImportBusy(false);
        if (r?.success) {
            if (onModelsChanged) await onModelsChanged();
            await dialog.alert(
                `导入完成: 共 ${r.data?.total || 0} 个模型\n新增 ${r.data?.created || 0}，更新 ${r.data?.updated || 0}`
            );
        } else {
            await dialog.alert('导入失败: ' + (r?.error || '未知错误'));
        }
    };

    const inputClass = "w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-600 transition-colors font-mono";
    const labelClass = "text-[11px] text-zinc-400 mb-1 block";

    return (
        <div className="flex-1 p-12 overflow-y-auto">
            <h2 className="text-lg font-bold text-zinc-100 mb-2">Gemini 逆向代理</h2>
            <p className="text-[11px] text-zinc-500 mb-6">
                管理 Gemini 网页版逆向代理服务（gemininixiang-main），将 Gemini 网页端能力封装为 OpenAI 兼容 API。
                启动服务后在后台配置 Cookie 即可使用。
            </p>

            {/* 服务状态与控制 */}
            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-sm font-semibold text-zinc-200">服务控制</h3>
                        <p className="text-[10px] text-zinc-500 mt-0.5">启动 Python FastAPI 服务，提供 OpenAI 兼容 API</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] border ${status?.running
                        ? 'text-emerald-300 border-emerald-700/60 bg-emerald-900/30'
                        : status?.status === 'starting' || status?.status === 'stopping'
                            ? 'text-amber-300 border-amber-700/60 bg-amber-900/30'
                            : status?.status === 'failed'
                                ? 'text-red-300 border-red-700/60 bg-red-900/30'
                                : 'text-zinc-400 border-zinc-700/60 bg-zinc-900/50'
                        }`}>
                        {status?.status || 'stopped'}
                    </span>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                        <label className={labelClass}>端口</label>
                        <input
                            className={inputClass}
                            value={port}
                            onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
                            placeholder="8000"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>API Key</label>
                        <input
                            className={inputClass}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="sk-geminixxxxx"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                        <label className={labelClass}>后台用户名</label>
                        <input
                            className={inputClass}
                            value={adminUsername}
                            onChange={(e) => setAdminUsername(e.target.value)}
                            placeholder="admin"
                        />
                    </div>
                    <div>
                        <label className={labelClass}>后台密码</label>
                        <input
                            className={inputClass}
                            type="password"
                            value={adminPassword}
                            onChange={(e) => setAdminPassword(e.target.value)}
                            placeholder="admin123"
                        />
                    </div>
                </div>

                <div className="text-[10px] text-zinc-600 font-mono mb-3">
                    Base URL: {`http://127.0.0.1:${Number(port) > 0 ? Number(port) : 8000}`}
                    {status?.pid ? ` · PID ${status.pid}` : ''}
                    {status?.startedAt ? ` · 启动于 ${new Date(status.startedAt).toLocaleTimeString()}` : ''}
                </div>

                {status?.lastError && (
                    <div className="text-[10px] text-red-300 bg-red-950/20 border border-red-900/40 rounded px-2 py-1 mb-3">
                        {status.lastError}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <button
                        onClick={handleStart}
                        disabled={busy || status?.running || status?.status === 'starting'}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                    >
                        {busy ? '处理中...' : '启动服务'}
                    </button>
                    <button
                        onClick={handleStop}
                        disabled={busy || (!status?.running && status?.status !== 'starting')}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-900 disabled:text-zinc-700 text-zinc-100 transition-colors"
                    >
                        停止服务
                    </button>
                    <button
                        onClick={handleOpenAdmin}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-700 text-zinc-100 transition-colors"
                    >
                        打开后台
                    </button>
                    <button
                        onClick={handleImportModels}
                        disabled={importBusy}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                    >
                        {importBusy ? '导入中...' : '导入全部模型'}
                    </button>
                    <button
                        onClick={handleSaveConfig}
                        disabled={saving}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                    >
                        {saving ? '保存中...' : '保存配置'}
                    </button>
                </div>

                {Array.isArray(status?.logs) && status.logs.length > 0 && (
                    <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-2 mt-3 max-h-32 overflow-y-auto custom-scrollbar">
                        {status.logs.slice(-8).map((log, idx) => (
                            <div key={idx} className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                                {log?.line}
                            </div>
                        ))}
                    </div>
                )}
            </div>



            {/* 使用说明 */}
            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-zinc-200 mb-3">使用说明</h3>
                <div className="space-y-2 text-[11px] text-zinc-400 leading-relaxed">
                    <p><span className="text-zinc-300 font-medium">1.</span> 启动服务后点击「打开后台」进入管理页面</p>
                    <p><span className="text-zinc-300 font-medium">2.</span> 在后台粘贴 Google 账号的浏览器 Cookie（从 gemini.google.com 获取）</p>
                    <p><span className="text-zinc-300 font-medium">3.</span> 点击「导入全部模型」将可用模型同步到 IDE 模型列表</p>
                    <p><span className="text-zinc-300 font-medium">4.</span> 在模型列表中选择 Gemini 模型即可开始使用</p>
                    <div className="border-t border-zinc-800 pt-2 mt-3">
                        <p className="text-[10px] text-zinc-500">
                            可用模型: gemini-3.0-flash（快速）、gemini-3.0-flash-thinking（思考）、gemini-3.0-pro（专业）
                        </p>
                        <p className="text-[10px] text-zinc-500 mt-1">
                            支持功能: 文本对话、多轮对话、图片识别、图片生成、视频生成、Function Calling
                        </p>
                        <p className="text-[10px] text-zinc-500 mt-1">
                            Token 自动刷新已内置，每 200-300 秒自动续期，无需手动干预。
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 主应用组件
// ============================================================
export default function App() {
    const [view, setView] = useState('home'); // 'home' | 'settings' | 'project'
    const [prevView, setPrevView] = useState(null); // 记录进入设置前的视图
    const [toasts, setToasts] = useState([]);
    const [recentProjects, setRecentProjects] = useState([]);
    const [currentProject, setCurrentProject] = useState(null); // 当前打开的项目
    const [savedProject, setSavedProject] = useState(null); // 进入设置时暂存项目
    // 启动时从本地存储加载最近项目
    useEffect(() => {
        const loadRecent = async () => {
            if (window.electronAPI) {
                const saved = await window.electronAPI.getRecentProjects();
                if (saved && saved.length > 0) {
                    setRecentProjects(saved);
                }
            }
        };
        loadRecent();
    }, []);

    const addToast = (message, type = 'success') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
    };

    const handleAddRecent = async (project) => {
        setRecentProjects(prev => {
            const filtered = prev.filter(p => p.path !== project.path);
            const updated = [project, ...filtered].slice(0, 20);

            if (window.electronAPI) {
                window.electronAPI.saveRecentProjects(updated);
            }

            return updated;
        });
    };

    // 打开项目 → 切换到项目界面
    const handleOpenProject = (project) => {
        setCurrentProject(project);
        setView('project');
        setToasts([]); // 清空历史提示，避免残留
    };

    // 返回首页
    const handleBackToHome = () => {
        setCurrentProject(null);
        setView('home');
    };

    // ProjectView 保持挂载（避免切设置时 Agent 执行状态丢失），用 CSS 隐藏
    const showProject = (view === 'project' || (prevView === 'project' && view === 'settings')) && (currentProject || savedProject);
    const projectForView = currentProject || savedProject;

    return (
        <div className="min-h-screen bg-black text-white font-sans selection:bg-emerald-500/30 overflow-hidden">
            {/* ProjectView 始终挂载，通过 display 控制可见性 */}
            {projectForView && (
                <div style={{ display: showProject && view === 'project' ? 'block' : 'none', position: 'absolute', inset: 0, zIndex: 10 }}>
                    <ProjectView
                        project={projectForView}
                        onBackToHome={handleBackToHome}
                        onOpenSettings={() => { setSavedProject(currentProject); setPrevView('project'); setView('settings'); }}
                    />
                </div>
            )}

            <div className="flex flex-col h-screen bg-[#0b0b0b] overflow-hidden" style={{ display: view === 'project' ? 'none' : 'flex' }}>
                <TitleBar />
                <main className="relative flex-1 overflow-hidden">
                    {view === 'home' ? (
                        <HomeView
                            onOpenSettings={() => { setPrevView('home'); setView('settings'); }}
                            addToast={addToast}
                            recentProjects={recentProjects}
                            onAddRecent={handleAddRecent}
                            onOpenProject={handleOpenProject}
                        />
                    ) : (
                        <SettingsView onClose={() => {
                            if (prevView === 'project' && savedProject) {
                                setCurrentProject(savedProject);
                                setSavedProject(null);
                                setView('project');
                            } else {
                                setView('home');
                            }
                            setPrevView(null);
                        }} />
                    )}
                </main>
                <div className="fixed bottom-0 right-0 p-6 flex flex-col gap-2 z-[100]">
                    {toasts.map(toast => (
                        <Toast
                            key={toast.id}
                            message={toast.message}
                            type={toast.type}
                            onClose={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
