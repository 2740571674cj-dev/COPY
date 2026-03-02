const fs = require('fs');
const fp = 'e:/COPY/cursor(V10)/src/App.jsx';
let src = fs.readFileSync(fp, 'utf8');
let changes = 0;

// 1. 添加 import (和 BarChart3 图标)
if (!src.includes('TokenDashboard')) {
    src = src.replace(
        "import WorkflowBattlePanel from './components/WorkflowBattlePanel';",
        "import WorkflowBattlePanel from './components/WorkflowBattlePanel';\nimport TokenDashboard from './components/TokenDashboard';"
    );
    changes++;
    console.log('[OK] import TokenDashboard');
}

// 2. 添加 BarChart3 图标 import
if (!src.includes('BarChart3')) {
    src = src.replace(
        "RotateCcw, RefreshCw",
        "RotateCcw, RefreshCw, BarChart3"
    );
    changes++;
    console.log('[OK] import BarChart3 icon');
}

// 3. 在 menuItems 中添加 Token 看板项（在 Version 前面）
if (!src.includes("id: 'TokenDashboard'")) {
    src = src.replace(
        "{ id: 'Version', label: '\u7248\u672c\u7ba1\u7406'",
        "{ id: 'TokenDashboard', label: 'Token \u770b\u677f', icon: <BarChart3 size={16} /> },\n        { id: 'Version', label: '\u7248\u672c\u7ba1\u7406'"
    );
    changes++;
    console.log('[OK] menuItems \u6dfb\u52a0 TokenDashboard');
}

// 4. 在 SettingsView 渲染中添加 TokenDashboard 面板
if (!src.includes("activeTab === 'TokenDashboard'")) {
    src = src.replace(
        "{activeTab === 'Version' && (",
        "{activeTab === 'TokenDashboard' && (\n                    <TokenDashboard />\n                )}\n\n                {activeTab === 'Version' && ("
    );
    changes++;
    console.log('[OK] SettingsView \u6e32\u67d3 TokenDashboard');
}

fs.writeFileSync(fp, src, 'utf8');
console.log(`\n\u2705 App.jsx: ${changes} \u5904\u4fee\u6539\u5b8c\u6210`);
