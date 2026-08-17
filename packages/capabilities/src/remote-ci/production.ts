import type {
  RemoteCiAuditAdapter,
  RemoteCiRepositoryInspectionAdapter,
  RemoteCiRevisionAdapter,
  RemoteCiToolAdapter,
  RemoteCiWorkspaceRootAdapter,
  RemoteCiWorkspaceSelectionAdapter
} from "../adapters.js";
import { GitHubGhCredentialProvider } from "./credential-provider.js";
import { GitHubRemoteCiAdapter } from "./github-adapter.js";
import { GitHubHttp } from "./github-http.js";
import { RemoteCiRepositoryResolver } from "./repository-resolver.js";
import { RemoteCiService } from "./service.js";

export interface GitHubRemoteCiToolAdapterDependencies {
  selections: RemoteCiWorkspaceSelectionAdapter;
  repository: RemoteCiRepositoryInspectionAdapter;
  roots: RemoteCiWorkspaceRootAdapter;
  revisions: RemoteCiRevisionAdapter;
  audit: RemoteCiAuditAdapter;
}

export function createGitHubRemoteCiToolAdapter(
  dependencies: GitHubRemoteCiToolAdapterDependencies
): RemoteCiToolAdapter {
  const service = (): RemoteCiService =>
    new RemoteCiService({
      resolver: new RemoteCiRepositoryResolver({
        selections: dependencies.selections,
        repository: dependencies.repository
      }),
      roots: dependencies.roots,
      revisions: dependencies.revisions,
      credentialProvider: new GitHubGhCredentialProvider(),
      adapterFactory: {
        create: (credential) =>
          new GitHubRemoteCiAdapter({
            http: new GitHubHttp({ credential: credential.token })
          })
      },
      audit: dependencies.audit
    });

  return {
    repository: (input) => service().repository(input),
    status: (input) => service().status(input),
    runs: (input) => service().runs(input),
    run: (input) => service().run(input),
    failure: (input) => service().failure(input),
    rerun: (input) => service().rerun(input),
    cancel: (input) => service().cancel(input),
    dispatch: (input) => service().dispatch(input)
  };
}
