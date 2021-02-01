
export interface tag {
  key:    string;
  value:  string;
}

export interface sg_props {
  sg_name:     string,
  sg_desc:     string,  
  inbound_rules:    rules_map[],
}

export interface rules_map {
  in: string;
  out: number;
  desc: string;
}