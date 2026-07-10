import { ReactNode } from 'react';

interface ApiParameter {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: string;
}

interface ApiTableProps {
  title?: string;
  description?: string;
  parameters?: ApiParameter[];
  returns?: {
    type: string;
    description: string;
  };
  children?: ReactNode;
}

export function ApiTable({ title, description, parameters, returns, children }: ApiTableProps) {
  return (
    <div className="my-8 rounded-lg border border-neutral-800 overflow-hidden">
      {title && (
        <div className="px-4 py-3 bg-[#111] border-b border-neutral-800">
          <code className="text-base font-semibold text-white">{title}</code>
          {description && (
            <p className="text-sm text-neutral-400 mt-1">{description}</p>
          )}
        </div>
      )}
      
      {parameters && parameters.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-neutral-900/50">
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-neutral-400 uppercase tracking-wider">Parameter</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-neutral-400 uppercase tracking-wider">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-neutral-400 uppercase tracking-wider">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {parameters.map((param, index) => (
                <tr key={index} className="hover:bg-neutral-900/30 transition-colors">
                  <td className="px-4 py-3">
                    <code className="text-sm text-blue-400">{param.name}</code>
                    {param.required !== false && (
                      <span className="ml-1 text-red-400 text-xs">*</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-sm text-purple-400">{param.type}</code>
                    {param.default && (
                      <span className="text-xs text-neutral-500 ml-2">= {param.default}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-neutral-300">{param.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      
      {returns && (
        <div className="px-4 py-3 bg-neutral-900/30 border-t border-neutral-800">
          <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Returns</span>
          <div className="mt-1.5 flex items-start gap-2">
            <code className="text-sm text-green-400">{returns.type}</code>
            <span className="text-sm text-neutral-400">— {returns.description}</span>
          </div>
        </div>
      )}
      
      {children && (
        <div className="px-4 py-3 border-t border-neutral-800 text-sm text-neutral-300">
          {children}
        </div>
      )}
    </div>
  );
}

// Simpler API signature component for inline use
interface ApiSignatureProps {
  name: string;
  signature: string;
  description?: string;
}

export function ApiSignature({ name, signature, description }: ApiSignatureProps) {
  return (
    <div className="my-4 p-4 rounded-lg bg-[#0a0a0a] border border-neutral-800">
      <code className="text-blue-400 font-semibold">{name}</code>
      <code className="text-neutral-400 ml-1">{signature}</code>
      {description && (
        <p className="text-sm text-neutral-400 mt-2">{description}</p>
      )}
    </div>
  );
}
