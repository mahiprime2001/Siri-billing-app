"use client"

import React from 'react'

interface VersionDisplayProps {
  version?: string
}

export default function VersionDisplay({ version }: VersionDisplayProps) {
  return (
    <div className="fixed bottom-2 right-2 text-xs text-gray-400 bg-white/80 backdrop-blur px-2 py-1 rounded shadow-sm">
      v{version}
    </div>
  )
}
