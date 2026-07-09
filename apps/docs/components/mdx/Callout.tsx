import { ReactNode } from 'react';

type CalloutType = 'info' | 'warning' | 'tip' | 'error' | 'success';

interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

// Geist-style Note component variants
const styles: Record<CalloutType, { bg: string; border: string; icon: string; iconColor: string; textColor: string }> = {
  info: {
    bg: 'bg-blue-1',
    border: 'border-blue-4',
    iconColor: 'text-blue-9',
    textColor: 'text-gray-11',
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  success: {
    bg: 'bg-green-1',
    border: 'border-green-4',
    iconColor: 'text-green-9',
    textColor: 'text-gray-11',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  warning: {
    bg: 'bg-amber-1',
    border: 'border-amber-4',
    iconColor: 'text-amber-9',
    textColor: 'text-gray-11',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  },
  error: {
    bg: 'bg-red-1',
    border: 'border-red-4',
    iconColor: 'text-red-9',
    textColor: 'text-gray-11',
    icon: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  tip: {
    bg: 'bg-green-1',
    border: 'border-green-4',
    iconColor: 'text-green-9',
    textColor: 'text-gray-11',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
  },
};

const defaultTitles: Record<CalloutType, string> = {
  info: 'Note',
  success: 'Success',
  warning: 'Warning',
  tip: 'Tip',
  error: 'Error',
};

export function Callout({ type = 'info', title, children }: CalloutProps) {
  const style = styles[type];
  const displayTitle = title || defaultTitles[type];

  return (
    <div className={`my-6 rounded-lg border ${style.bg} ${style.border} p-4`}>
      <div className="flex items-start gap-3">
        <svg 
          className={`w-5 h-5 mt-0.5 flex-shrink-0 ${style.iconColor}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={style.icon} />
        </svg>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm mb-1 ${style.iconColor}`}>
            {displayTitle}
          </p>
          <div className={`${style.textColor} text-sm leading-relaxed [&>p]:m-0 [&>p:last-child]:mb-0 [&>code]:bg-gray-2 [&>code]:px-1.5 [&>code]:py-0.5 [&>code]:rounded [&>code]:text-xs`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
