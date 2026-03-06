export interface PromptImage {
  url: string;
}

export interface PromptSimilar {
  content: string;
  contributor?: string;
  notes?: string;
  images?: string[];
}

export interface PromptItem {
  id: string;
  title: string;
  content: string;
  createdAt?: number;
  tags?: string[];
  contributor?: string;
  notes?: string;
  images?: string[];
  refs?: string[];
  similar?: PromptSimilar[];
  isFavorite?: boolean; // 本地状态
}

export interface PromptSection {
  id: string;
  title: string;
  isCollapsed?: boolean;
  isRestricted?: boolean;
  prompts: PromptItem[];
}

export interface PromptData {
  sections: PromptSection[];
  prompts?: PromptItem[];
  commonTags?: string[];
  siteNotes?: string;
  lastUpdated?: string;
}
