/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        plex: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: { 950: '#06060a', 900: '#0b0b12', 800: '#12121c', 700: '#1b1b28' },
        butter: '#FFF2B4',
        vista: { coral: '#FF6044', mint: '#EFFFEB', card: '#454842', line: '#2b2c29' },
      },
      keyframes: {
        'line-up': { from: { transform: 'translateY(105%)' }, to: { transform: 'none' } },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        'fade-up': { from: { opacity: 0, transform: 'translateY(14px)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
      },
      animation: {
        'fade-up': 'fade-up .6s cubic-bezier(.2,.7,.2,1) both',
        shimmer: 'shimmer 2.4s linear infinite',
        float: 'float 6s ease-in-out infinite',
        'line-up': 'line-up 1s cubic-bezier(.2,.7,.2,1) both',
        marquee: 'marquee 40s linear infinite',
      },
    },
  },
  plugins: [],
}
