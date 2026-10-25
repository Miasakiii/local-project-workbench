import type { ProjectPage as ProjectPageName, ProjectSummary } from '@shared/types'
import { ChangesView } from './ChangesView'
import { FileBrowser } from './FileBrowser'
import { OverviewView } from './OverviewView'

interface ProjectContentProps {
  project: ProjectSummary
  page: ProjectPageName
  restored: boolean
  filePath: string
  filesPaneWidth: number
  changeToken: number
  editorPath: string | null
  onScrollTopChange: (scrollTop: number) => void
  onReadmePathChange: (next: string | null) => Promise<void>
  onAllowNetworkImagesChange: (next: boolean) => Promise<void>
  onNavigateProjectPath: (relativePath: string) => void
  onPaneWidthChange: (width: number) => void
  onPathChange: (path: string) => void
  onOpenTerminalAt: (relativePath: string) => void
}

export function ProjectContent({
  project,
  page,
  restored,
  filePath,
  filesPaneWidth,
  changeToken,
  editorPath,
  onScrollTopChange,
  onReadmePathChange,
  onAllowNetworkImagesChange,
  onNavigateProjectPath,
  onPaneWidthChange,
  onPathChange,
  onOpenTerminalAt
}: ProjectContentProps): React.JSX.Element {
  return (
    <main
      className="project-content"
      role="tabpanel"
      id="page-panel"
      aria-labelledby={`seg-tab-${page}`}
      onScroll={(event) => onScrollTopChange(event.currentTarget.scrollTop)}
    >
      {page === 'overview' ? (
        <OverviewView
          projectId={project.id}
          readmePath={project.readmePath}
          allowNetworkImages={project.allowNetworkImages}
          onReadmePathChange={onReadmePathChange}
          onAllowNetworkImagesChange={onAllowNetworkImagesChange}
          onNavigateProjectPath={onNavigateProjectPath}
        />
      ) : null}

      {page === 'files' && restored ? (
        <FileBrowser
          projectId={project.id}
          trusted={project.trusted}
          editorPath={editorPath}
          initialPath={filePath}
          paneWidth={filesPaneWidth}
          refreshToken={changeToken}
          onPaneWidthChange={onPaneWidthChange}
          onPathChange={onPathChange}
          onNavigateProjectPath={onNavigateProjectPath}
          onOpenTerminalAt={onOpenTerminalAt}
        />
      ) : null}

      {page === 'changes' ? (
        <ChangesView projectId={project.id} isGitRepository={project.isGitRepository} refreshToken={changeToken} />
      ) : null}
    </main>
  )
}
