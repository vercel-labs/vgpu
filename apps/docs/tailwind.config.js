/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    './mdx-components.tsx',
  ],
  theme: {
    extend: {
      colors: {
        // Geist Design System - Gray Scale (10-step)
        gray: {
          1: '#0a0a0a',    // Component bg default
          2: '#111111',    // Component bg hover
          3: '#191919',    // Component bg active
          4: '#222222',    // Border default
          5: '#2a2a2a',    // Border hover
          6: '#313131',    // Border active
          7: '#3a3a3a',    // High contrast bg
          8: '#484848',    // High contrast bg hover
          9: '#606060',    // Secondary text/icons
          10: '#6e6e6e',   // Secondary text lighter
          11: '#b4b4b4',   // Primary muted text
          12: '#eeeeee',   // Primary text
        },
        // Geist Blue Scale
        blue: {
          1: '#0d1520',
          2: '#111d2e',
          3: '#112a46',
          4: '#0f3460',
          5: '#0f4280',
          6: '#1058a7',
          7: '#1a74d0',
          8: '#3291ff',
          9: '#0070f3',    // Primary blue (Vercel brand)
          10: '#3b9eff',
        },
        // Geist Green Scale
        green: {
          1: '#0e1512',
          2: '#121b17',
          3: '#132d21',
          4: '#113b29',
          5: '#174933',
          6: '#20573e',
          7: '#28684a',
          8: '#2f7c57',
          9: '#46a758',
          10: '#55b467',
        },
        // Geist Amber/Yellow Scale
        amber: {
          1: '#16120c',
          2: '#1d180f',
          3: '#302008',
          4: '#3f2700',
          5: '#4d3000',
          6: '#5c3d05',
          7: '#714f19',
          8: '#8f6424',
          9: '#ffc53d',
          10: '#ffd60a',
        },
        // Geist Red Scale
        red: {
          1: '#191111',
          2: '#201314',
          3: '#3b1219',
          4: '#500f1c',
          5: '#611a21',
          6: '#72232d',
          7: '#8c333a',
          8: '#b54548',
          9: '#e5484d',
          10: '#f2555a',
        },
        // Geist Purple Scale
        purple: {
          1: '#14121f',
          2: '#18162d',
          3: '#221c47',
          4: '#2a2159',
          5: '#32286b',
          6: '#3b307e',
          7: '#483d92',
          8: '#5b4fb1',
          9: '#6e56cf',
          10: '#7c66dc',
        },
        // Geist Pink Scale
        pink: {
          1: '#191117',
          2: '#21121d',
          3: '#37172f',
          4: '#4b143d',
          5: '#591a49',
          6: '#692056',
          7: '#7e2968',
          8: '#a23882',
          9: '#d6409f',
          10: '#e34ba9',
        },
        // Geist Teal Scale
        teal: {
          1: '#0d1514',
          2: '#111c1b',
          3: '#0d2d2a',
          4: '#023b37',
          5: '#084843',
          6: '#145750',
          7: '#1c6961',
          8: '#207e73',
          9: '#12a594',
          10: '#0eb39e',
        },
        // Legacy aliases (for backward compatibility during migration)
        background: {
          DEFAULT: '#000000',
          secondary: '#0a0a0a',  // Same as gray-1
          tertiary: '#111111',   // Same as gray-2
        },
        foreground: {
          DEFAULT: '#fafafa',
          secondary: '#a1a1a1',
          muted: '#666666',
        },
        // Keep primary for backward compatibility
        primary: {
          400: '#3b9eff',   // blue-10
          500: '#0070f3',   // blue-9
          600: '#0366d6',
        },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        'xs': ['0.75rem', { lineHeight: '1rem' }],
        'sm': ['0.875rem', { lineHeight: '1.5rem' }],
        'base': ['1rem', { lineHeight: '1.75rem' }],
        'lg': ['1.125rem', { lineHeight: '1.75rem' }],
        'xl': ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
        '5xl': ['3rem', { lineHeight: '1' }],
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      },
      borderColor: {
        DEFAULT: '#222222',  // gray-4
        hover: '#2a2a2a',    // gray-5
      },
      borderRadius: {
        'lg': '0.5rem',
        'xl': '0.75rem',
        '2xl': '1rem',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(0, 112, 243, 0.15)',
        'glow-sm': '0 0 10px rgba(0, 112, 243, 0.1)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
