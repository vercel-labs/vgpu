'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { PackageNav } from './PackageNav';

const navItems = [
  {
    label: 'Documentation',
    items: [
      { href: '/', label: 'Introduction' },
      { href: '/getting-started', label: 'Getting Started' },
      { href: '/concepts', label: 'Core Concepts' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { href: '/api', label: 'API Overview' },
      { href: '/packages', label: 'Packages' },
      { href: '/examples', label: 'Examples' },
    ],
  },
];

export function Navigation() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <button
        className="lg:hidden fixed top-4 right-4 z-50 p-2 rounded-md bg-gray-2 border border-gray-4 text-gray-12 hover:bg-gray-1 transition-colors"
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        aria-label="Toggle menu"
      >
        {mobileMenuOpen ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-black border-r border-gray-4 transform transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-full flex flex-col">
          <div className="h-16 px-6 flex items-center border-b border-gray-4">
            <Link
              href="/"
              className="flex items-center gap-3 group"
              onClick={() => setMobileMenuOpen(false)}
            >
              <svg className="w-5 h-5" viewBox="0 0 76 65" fill="white" aria-hidden="true">
                <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
              </svg>
              <span className="text-[15px] font-semibold text-gray-12">vgpu</span>
              <span className="text-xs text-gray-9 bg-gray-2 px-1.5 py-0.5 rounded">Docs</span>
            </Link>
          </div>

          <nav className="flex-1 overflow-y-auto py-6 px-3">
            {navItems.map((section, idx) => (
              <div key={section.label} className={idx > 0 ? 'mt-8' : ''}>
                <h4 className="px-3 mb-2 text-xs font-medium text-gray-9 uppercase tracking-wider">
                  {section.label}
                </h4>
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setMobileMenuOpen(false)}
                          className={`block px-3 py-2 rounded-md text-sm transition-colors ${
                            isActive
                              ? 'bg-gray-2 text-gray-12 font-medium'
                              : 'text-gray-10 hover:bg-gray-1 hover:text-gray-12'
                          }`}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {section.label === 'Reference' ? <PackageNav /> : null}
              </div>
            ))}
          </nav>

          <div className="p-4 border-t border-gray-4">
            <a
              href="https://github.com/vercel-labs/vgpu"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 text-gray-10 hover:text-gray-12 transition-colors text-sm rounded-md hover:bg-gray-1"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <span>View on GitHub</span>
            </a>
          </div>
        </div>
      </aside>

      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
    </>
  );
}
