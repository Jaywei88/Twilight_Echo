export interface LocalLibraryRenameItem {
  filePath: string
  fileName: string
}

export interface LocalLibraryRenameRequest {
  items: LocalLibraryRenameItem[]
}

export interface LocalLibraryRenameSidecar {
  from: string
  to: string
  status: 'moved' | 'failed'
  message?: string
}

export interface LocalLibraryRenameItemResult {
  filePath: string
  newFilePath?: string
  status: 'success' | 'failed'
  message?: string
  sidecars: LocalLibraryRenameSidecar[]
}

export interface LocalLibraryRenameResult {
  items: LocalLibraryRenameItemResult[]
}
