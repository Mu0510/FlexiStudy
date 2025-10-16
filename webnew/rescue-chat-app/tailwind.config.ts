import type { Config } from 'tailwindcss'
import baseConfig from '../tailwind.config'

const sharedContent = Array.isArray(baseConfig.content)
  ? (baseConfig.content as string[])
  : []

const extraContent = [
  './app/**/*.{ts,tsx}',
  './components/**/*.{ts,tsx}',
  '../app/**/*.{ts,tsx}',
  '../components/**/*.{ts,tsx}',
  '../context/**/*.{ts,tsx}',
  '../hooks/**/*.{ts,tsx}',
  '../lib/**/*.{ts,tsx}',
]

const config: Config = {
  ...baseConfig,
  content: Array.from(new Set([...sharedContent, ...extraContent])),
}

export default config
