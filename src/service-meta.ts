// Static, non-secret descriptions of each media service: what it is and what group it
// belongs to on the Media tab. Per-deployment facts (addresses, versions, state) come from
// config and the monitors instead — see media.ts and config.ts. A service with no entry here
// still renders, just without a role or description.

export type ServiceGroup = "play" | "lib" | "fetch" | "other";

export const GROUP_LABELS: Record<ServiceGroup, string> = {
  play: "Player",
  lib: "Librarian",
  fetch: "Source & downloader",
  other: "Other",
};

export interface ServiceMeta {
  group: ServiceGroup;
  role: string;
  description: string;
}

export const SERVICE_META: Record<string, ServiceMeta> = {
  plex: {
    group: "play",
    role: "Films, TV, Music, AudioBooks",
    description:
      "The media player everyone watches through, on TVs, phones and browsers. Holds the libraries, remembers where each person stopped, and converts video on the fly for devices that need it.",
  },
  audiobookshelf: {
    group: "play",
    role: "Audiobook and ebook player",
    description:
      "Keeps each listener's place in each book and syncs it across devices, handles chaptered books properly, and offers downloads for offline listening.",
  },
  navidrome: {
    group: "play",
    role: "Music player",
    description:
      "A music-only player over the same files Plex uses: quicker to browse, with its own logins and playlists, and works with many third-party phone apps.",
  },
  sonarr: {
    group: "lib",
    role: "TV",
    description:
      "The TV librarian. Add a series once; it watches for each new episode, hands it to a downloader, then renames and files it, and tracks which episodes are still missing.",
  },
  radarr: {
    group: "lib",
    role: "Films",
    description:
      "The same idea for films: add one, and it keeps looking until a copy matching the quality rules appears, then files it where Plex expects.",
  },
  lidarr: {
    group: "lib",
    role: "Music requests",
    description: "The same idea again for music: follow an artist or ask for an album, and it fetches and tags the files.",
  },
  lazylibrarian: {
    group: "lib",
    role: "Ebooks and audiobooks",
    description: "The book librarian: keeps the wanted list, searches for each title, and files what it finds by author.",
  },
  prowlarr: {
    group: "fetch",
    role: "Feeds indexers to the others",
    description:
      "The shared address book of sources. Each indexer is set up once here, and the other apps search through it, so a changed key is fixed in one place.",
  },
  sabnzbd: {
    group: "fetch",
    role: "Usenet downloads",
    description: "One of the downloaders. Fetches, repairs and unpacks from Usenet, then tells the librarian a download is ready to file.",
  },
  qbittorrent: {
    group: "fetch",
    role: "Torrent downloads",
    description: "The other downloader, for torrents. Finished torrents are left seeding on purpose where the source expects it.",
  },
};

export function serviceMeta(id: string): ServiceMeta {
  return SERVICE_META[id] ?? { group: "other", role: "", description: "" };
}
