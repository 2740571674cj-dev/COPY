import React, { useState, useCallback } from 'react';
import { HelpCircle, CheckSquare, Square, ChevronRight } from 'lucide-react';

export default function QuestionPanel({ title, questions, onSubmit, onCancel }) {
  const [answers, setAnswers] = useState(() => {
    const init = {};
    for (const q of questions) {
      init[q.id] = q.type === 'text' ? '' : (q.allow_multiple ? [] : null);
    }
    return init;
  });

  const handleSelect = useCallback((questionId, optionId, allowMultiple) => {
    setAnswers(prev => {
      const next = { ...prev };
      if (allowMultiple) {
        const arr = [...(next[questionId] || [])];
        const idx = arr.indexOf(optionId);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(optionId);
        next[questionId] = arr;
      } else {
        next[questionId] = optionId;
      }
      return next;
    });
  }, []);

  const handleText = useCallback((questionId, value) => {
    setAnswers(prev => ({ ...prev, [questionId]: value }));
  }, []);

  const allAnswered = questions.every(q => {
    const a = answers[q.id];
    if (q.type === 'text') return typeof a === 'string' && a.trim().length > 0;
    if (q.allow_multiple) return a && a.length > 0;
    return a != null;
  });

  const handleSubmit = () => {
    if (!allAnswered) return;
    onSubmit(answers);
  };

  return (
    <div className="ml-5 mr-1 mt-1.5 mb-2 rounded-lg border border-blue-800/30 bg-blue-950/10 overflow-hidden">
      {title && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-blue-800/20 bg-blue-950/15">
          <HelpCircle size={13} className="text-blue-400 shrink-0" />
          <span className="text-[12px] text-blue-300 font-medium">{title}</span>
        </div>
      )}

      <div className="px-3 py-2 space-y-3">
        {questions.map((q) => (
          <div key={q.id}>
            <div className="text-[12px] text-zinc-200 mb-1.5">
              {q.prompt || q.label}
              {q.allow_multiple && (
                <span className="text-zinc-500 text-[11px] ml-1">(可多选)</span>
              )}
            </div>
            {q.type === 'text' ? (
              <textarea
                className="w-full rounded bg-zinc-800/60 border border-zinc-700/40 text-zinc-200 text-[12px] px-2.5 py-2 resize-y min-h-[60px] focus:border-blue-500/50 focus:outline-none transition-colors"
                placeholder="请在此输入..."
                value={answers[q.id] || ''}
                onChange={(e) => handleText(q.id, e.target.value)}
                rows={3}
              />
            ) : (
              <div className="space-y-1">
                {(q.options || []).map((opt) => {
                  const isSelected = q.allow_multiple
                    ? (answers[q.id] || []).includes(opt.id)
                    : answers[q.id] === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelect(q.id, opt.id, q.allow_multiple)}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors text-[12px] ${isSelected
                        ? 'bg-blue-600/20 border border-blue-500/40 text-blue-200'
                        : 'bg-zinc-800/40 border border-zinc-700/30 text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-300'
                        }`}
                    >
                      {q.allow_multiple ? (
                        isSelected
                          ? <CheckSquare size={13} className="text-blue-400 shrink-0" />
                          : <Square size={13} className="text-zinc-600 shrink-0" />
                      ) : (
                        <div className={`w-3 h-3 rounded-full border shrink-0 flex items-center justify-center ${isSelected ? 'border-blue-400 bg-blue-500' : 'border-zinc-600'
                          }`}>
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                      )}
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-blue-800/20">
        <button
          onClick={onCancel}
          className="px-3 py-1 text-[11px] rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={`px-3 py-1 text-[11px] rounded text-white transition-colors flex items-center gap-1 ${allAnswered
            ? 'bg-blue-600 hover:bg-blue-500'
            : 'bg-zinc-600 cursor-not-allowed text-zinc-400'
            }`}
        >
          确认
          <ChevronRight size={11} />
        </button>
      </div>
    </div>
  );
}
