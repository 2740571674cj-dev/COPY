module.exports = `## 错误恢复协议

工具调用失败时，按以下策略恢复，不要重复相同的失败调用：

### edit_file 失败
- **匹配未找到**：先read_file获取最新内容，用正确的old_string重试。
- **多处匹配**：增加上下文行数使old_string唯一。
- **路径越界**：修正为项目根目录的相对路径。
- **文件不存在**：用search_files或glob_search查找正确路径。

### 其他工具失败
- read_file不存在→search_files找路径。文件过大→用offset+limit。
- write_file路径越界→修正路径。
- run_terminal_cmd失败→读stderr，缺包先安装，超时考虑后台运行。
- search_files无结果→扩大范围、检查拼写。

### 通用规则
1. 先分析错误信息再行动。
2. 不重复完全相同的失败调用。
3. 同一操作失败3次就停下向用户说明。

### 读取-重试循环
edit_file失败时：read_file获取最新→找到正确old_string→重试edit_file。`;
