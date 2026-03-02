const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, 'cursor(V10)/src/core/llm-gateway.js');
const content = fs.readFileSync(targetPath, 'utf8');

const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // If a line has FFFD or other weird chars
  if (/[^\x00-\x7F]/.test(line)) {
    if (line.includes('//') && !line.includes('Example') && !line.includes('Format 2:')) {
      // Just a comment line with mojibake
      if (line.includes('strictAlternation')) {
        lines[i] = '  // Fix: handle consecutive assistant messages in strictAlternation mode';
      } else if (line.includes('usageData = null;')) {
        lines[i] = '    let usageData = null; // [Token Dashboard] record usage of last chunk';
      } else if (line.includes("lastFinishReason = 'interrupted';")) {
        lines[i] = "            lastFinishReason = 'interrupted'; // Stream interrupted";
      } else if (line.includes('usage: usageData,')) {
        lines[i] = '      usage: usageData, // [Token Dashboard] pass usage to controller';
      } else {
        lines[i] = line.replace(/[^\x00-\x7F]+/g, '[comment]');
      }
    } else if (line.includes('/**') || line.includes('*') && line.trim().startsWith('*')) {
      // Block comment
      lines[i] = line.replace(/[^\x00-\x7F]+/g, '[comment]');
    } else if (line.includes("'Example ")) {
      lines[i] = "      + 'Example - to read a file:\\n'";
    } else if (line.includes('Format 2:')) {
      lines[i] = "    // Format 2: Direct tag format - <tool_name><param>value</param></tool_name>";
    } else if (line.includes('Case 1:')) {
      lines[i] = "    // Case 1: Simple cumulative - incoming starts with current content - replace.";
    } else if (line.includes('Case 2:')) {
      lines[i] = "    // Case 2: Exact duplicate chunk (same content resent) - keep current.";
    } else {
      lines[i] = line.replace(/[^\x00-\x7F]+/g, '[char]');
    }
  }
}

// Ensure the BOM is stripped if present
let result = lines.join('\n');
if (result.charCodeAt(0) === 0xFEFF) {
  result = result.slice(1);
}

fs.writeFileSync(targetPath, result, 'utf8');
console.log('Cleaned up mojibake from', targetPath);
