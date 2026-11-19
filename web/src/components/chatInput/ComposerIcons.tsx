import type { ReactNode } from 'react'

const Frame = ({ children }: { children: ReactNode }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const AddIcon = () => (
  <Frame>
    <path d="M12 5v14M5 12h14" />
  </Frame>
)
export const CameraIcon = () => (
  <Frame>
    <path d="M8 5 6.5 8H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2.5L16 5Z" />
    <circle cx="12" cy="14" r="4" />
  </Frame>
)
export const ImageIcon = () => (
  <Frame>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <circle cx="8" cy="8" r="1.5" />
    <path d="m3 17 6-6 4 4 3-3 5 5" />
  </Frame>
)
export const FileIcon = () => (
  <Frame>
    <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Z" />
    <path d="M13 3v7h7M8 14h8M8 17h5" />
  </Frame>
)
export const ChatIcon = () => (
  <Frame>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4h2A8.5 8.5 0 0 1 21 11.5Z" />
    <path d="M7 10h9M7 14h6" />
  </Frame>
)
