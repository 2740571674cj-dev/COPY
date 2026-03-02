class EditFuzzyMatcher {
  findMatch(content, searchStr, replaceAll = false) {
    if (!content || !searchStr || typeof content !== 'string' || typeof searchStr !== 'string') {
      return { found: false, error: 'Invalid input: content and searchStr must be non-empty strings.', code: 'E_INVALID_INPUT' };
    }
    // Track strongest failure across strategies so E_MULTIPLE_MATCHES is never downgraded.
    let strongestError = null;

    const strategies = [
      () => this._exactMatch(content, searchStr, replaceAll),
      () => this._whitespaceNormalized(content, searchStr, replaceAll),
      () => this._indentAgnostic(content, searchStr, replaceAll),
      () => this._lineTrimmed(content, searchStr, replaceAll),
      () => this._subsequenceMatch(content, searchStr, replaceAll),
    ];
    const strategyNames = ['exact', 'whitespace_normalized', 'indent_agnostic', 'line_trimmed', 'subsequence'];

    for (let i = 0; i < strategies.length; i++) {
      const result = strategies[i]();
      if (result.found) return { ...result, strategy: strategyNames[i] };

      // Preserve the strongest error (E_MULTIPLE_MATCHES > E_MATCH_NOT_FOUND)
      if (result.code === 'E_MULTIPLE_MATCHES' && (!strongestError || strongestError.code !== 'E_MULTIPLE_MATCHES')) {
        strongestError = { error: result.error, code: result.code, candidateCount: result.candidateCount };
      }
    }

    // Return strongest error if available, otherwise generic not-found.
    if (strongestError) {
      return { found: false, ...strongestError };
    }

    return {
      found: false,
      error: 'old_string not found in file. The content may have changed — use read_file to get current content, then retry with the correct old_string.',
      code: 'E_MATCH_NOT_FOUND',
    };
  }

  _exactMatch(content, searchStr, replaceAll) {
    const idx = content.indexOf(searchStr);
    if (idx === -1) return { found: false };

    if (!replaceAll) {
      const secondIdx = content.indexOf(searchStr, idx + 1);
      if (secondIdx !== -1) {
        const count = content.split(searchStr).length - 1;
        return {
          found: false,
          error: `old_string matches ${count} locations. Include more surrounding context to make it unique.`,
          code: 'E_MULTIPLE_MATCHES',
        };
      }
    }

    return {
      found: true,
      start: idx,
      end: idx + searchStr.length,
      count: replaceAll ? content.split(searchStr).length - 1 : 1,
    };
  }

  _whitespaceNormalized(content, searchStr, replaceAll) {
    const normalize = (s) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
    const normContent = normalize(content);
    const normSearch = normalize(searchStr);

    const idx = normContent.indexOf(normSearch);
    if (idx === -1) return { found: false };

    // Map back to original positions
    const mapping = this._buildPositionMap(content, normContent);
    const originalStart = mapping[idx] ?? idx;
    const originalEnd = mapping[idx + normSearch.length] ?? (idx + normSearch.length);

    if (!replaceAll) {
      const secondIdx = normContent.indexOf(normSearch, idx + 1);
      if (secondIdx !== -1) {
        return {
          found: false,
          error: 'old_string matches multiple locations after whitespace normalization.',
          code: 'E_MULTIPLE_MATCHES',
        };
      }
    }

    return {
      found: true,
      start: originalStart,
      end: originalEnd,
      count: replaceAll ? normContent.split(normSearch).length - 1 : 1,
    };
  }

  _indentAgnostic(content, searchStr, replaceAll) {
    const contentLines = content.split('\n');
    const searchLines = searchStr.split('\n').map(l => l.trimStart());

    if (searchLines.length === 0) return { found: false };

    const matches = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trimStart() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const startOffset = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
        const matchedText = contentLines.slice(i, i + searchLines.length).join('\n');
        const endOffset = startOffset + matchedText.length;
        matches.push({ start: startOffset, end: endOffset });
      }
    }

    if (matches.length === 0) return { found: false };
    if (!replaceAll && matches.length > 1) {
      return {
        found: false,
        error: `old_string matches ${matches.length} locations (indent-agnostic). Include more context.`,
        code: 'E_MULTIPLE_MATCHES',
      };
    }

    return { found: true, start: matches[0].start, end: matches[0].end, count: matches.length };
  }

  _lineTrimmed(content, searchStr, replaceAll) {
    const contentLines = content.split('\n');
    const searchLines = searchStr.split('\n').map(l => l.trim());

    if (searchLines.length === 0) return { found: false };

    const matches = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let match = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const startOffset = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
        const matchedText = contentLines.slice(i, i + searchLines.length).join('\n');
        const endOffset = startOffset + matchedText.length;
        matches.push({ start: startOffset, end: endOffset });
      }
    }

    if (matches.length === 0) return { found: false };
    if (!replaceAll && matches.length > 1) {
      return {
        found: false,
        error: `old_string matches ${matches.length} locations (trimmed). Include more context.`,
        code: 'E_MULTIPLE_MATCHES',
      };
    }

    return { found: true, start: matches[0].start, end: matches[0].end, count: matches.length };
  }

  _buildPositionMap(original, normalized) {
    const map = {};
    let oi = 0;
    let ni = 0;
    while (oi < original.length && ni < normalized.length) {
      map[ni] = oi;
      if (original[oi] === normalized[ni]) {
        oi++;
        ni++;
      } else {
        oi++;
      }
    }
    map[ni] = oi;
    return map;
  }

  /**
   * 子串匹配策略：当 old_string 的行与文件行有足够高的相似度（70%+ 行 trim 后匹配）时命中。
   * 解决 AI 常见失败：old_string 多了/少了几行、某行有细微差异。
   * 要求至少 3 行才启用此策略，且匹配的连续段至少覆盖 old_string 行数的 70%。
   */
  _subsequenceMatch(content, searchStr, replaceAll) {
    const contentLines = content.split('\n');
    const searchLines = searchStr.split('\n');

    // 至少 3 行才启用，避免误匹配
    if (searchLines.length < 3 || contentLines.length < 3) return { found: false };

    const searchTrimmed = searchLines.map(l => l.trim()).filter(Boolean);
    if (searchTrimmed.length < 3) return { found: false };

    // 查找 searchTrimmed 中的"锚行"——最长且最独特的行
    const anchor = searchTrimmed.reduce((a, b) => a.length >= b.length ? a : b, '');
    if (anchor.length < 5) return { found: false };

    // 在文件中找到所有锚行的位置
    const anchorPositions = [];
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].trim() === anchor) {
        anchorPositions.push(i);
      }
    }
    if (anchorPositions.length === 0) return { found: false };

    // 对每个锚行位置，尝试前后扩展找到最佳匹配范围
    const candidates = [];
    for (const anchorIdx of anchorPositions) {
      const anchorInSearch = searchTrimmed.indexOf(anchor);

      // 从锚行向前后扩展
      let startInFile = anchorIdx - anchorInSearch;
      if (startInFile < 0) startInFile = 0;

      let endInFile = startInFile + searchLines.length;
      if (endInFile > contentLines.length) endInFile = contentLines.length;

      // 计算匹配行数
      let matchCount = 0;
      const fileSliceTrimmed = contentLines.slice(startInFile, endInFile).map(l => l.trim());
      for (const sl of searchTrimmed) {
        if (fileSliceTrimmed.includes(sl)) matchCount++;
      }

      const matchRatio = matchCount / searchTrimmed.length;
      if (matchRatio >= 0.7) {
        candidates.push({ start: startInFile, end: endInFile, matchRatio });
      }
    }

    if (candidates.length === 0) return { found: false };
    if (!replaceAll && candidates.length > 1) {
      // 选择匹配度最高的候选
      candidates.sort((a, b) => b.matchRatio - a.matchRatio);
      if (candidates[0].matchRatio === candidates[1].matchRatio) {
        return {
          found: false,
          error: `old_string matches ${candidates.length} locations (subsequence). Include more context.`,
          code: 'E_MULTIPLE_MATCHES',
        };
      }
    }

    const best = candidates[0];
    const startOffset = contentLines.slice(0, best.start).join('\n').length + (best.start > 0 ? 1 : 0);
    const matchedText = contentLines.slice(best.start, best.end).join('\n');
    const endOffset = startOffset + matchedText.length;

    return { found: true, start: startOffset, end: endOffset, count: 1 };
  }
}

module.exports = { EditFuzzyMatcher };
