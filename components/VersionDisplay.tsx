'use client'

import React from 'react'
import packageJson from '../package.json'

export default function VersionDisplay() {
  return (
    <div className="fixed bottom-2 right-2 text-xs text-gray-400 bg-white/80 backdrop-blur px-2 py-1 rounded shadow-sm">
      v{packageJson.version}
    </div>
  )
}
