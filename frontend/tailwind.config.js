/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Inter is self-hosted (public/fonts): the Factory must render the same offline / air-gapped.
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // Brand: Pantone 340 C — RGB (0, 148, 100) = #009464. 500 is the exact Pantone value; the other
        // steps are tints/shades of the same hue so every Tailwind step exists.
        brand: {
          DEFAULT: '#009464',
          50: '#E8F6F0',
          100: '#C7EADC',
          200: '#93D6BC',
          300: '#58BE98',
          400: '#22A87C',
          500: '#009464',
          600: '#007F56',
          700: '#006847',
          800: '#005139',
          900: '#003B2A',
          950: '#00251A',
        },
        // Dark "ink" neutrals (DOINg.AI). Light mode stays on Tailwind zinc.
        ink: {
          950: '#050505',
          900: '#0A0A0B',
          800: '#0F0F11',
          700: '#15151A',
          600: '#1C1C22',
          500: '#26262E',
          400: '#3A3A45',
        },
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        brand: '0 8px 24px -8px rgba(0, 148, 100, 0.45)',
        pop: '0 12px 40px -12px rgba(0, 0, 0, 0.35)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: { '0%': { backgroundPosition: '200% 0' }, '100%': { backgroundPosition: '-200% 0' } },
        // Dashed edges on the Factory Floor: animating the dash offset makes work visibly "flow".
        flow: { '0%': { strokeDashoffset: '24' }, '100%': { strokeDashoffset: '0' } },
        'progress-stripes': { '0%': { backgroundPosition: '1rem 0' }, '100%': { backgroundPosition: '0 0' } },
        'gradient-x': { '0%,100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
      },
      animation: {
        'fade-in': 'fade-in .25s ease-out both',
        'slide-up': 'slide-up .35s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right .3s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in .18s ease-out both',
        shimmer: 'shimmer 1.8s linear infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        flow: 'flow 1s linear infinite',
        'progress-stripes': 'progress-stripes 1s linear infinite',
        'gradient-x': 'gradient-x 4s ease infinite',
      },
    },
  },
  plugins: [],
};
