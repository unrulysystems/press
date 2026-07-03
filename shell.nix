# Fallback for non-flake Nix users
let
  flakeCompat = fetchTarball {
    url = "https://github.com/edolstra/flake-compat/archive/5edf11c44bc78a0d334f6334cdaf7d60d732daab.tar.gz";
    sha256 = "sha256-vNpUSpF5Nuw8xvDLj2KCwwksIbjua2LZCqhV1LNRDns=";
  };
in
(import flakeCompat {
  src = ./.;
}).shellNix
