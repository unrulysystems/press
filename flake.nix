{
  description = "TypeScript project template";

  inputs = {
    # Track the latest stable release channel: recent tool versions AND fully
    # Hydra-built/cached for darwin. nixpkgs-unstable lags on darwin for some
    # packages, which forces slow source builds; stable avoids that trap.
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";

    # Uncomment for overlays that require unfree packages (e.g., atlas-overlay)
    # nixpkgs-unfree.url = "github:numtide/nixpkgs-unfree/nixos-26.05";
    # nixpkgs-unfree.inputs.nixpkgs.follows = "nixpkgs";
    tilt-overlay = {
      url = "github:alleneubank/tilt-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Used for shell.nix
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    tilt-overlay,
    ...
  } @ inputs: let
    # Official-binary overlays shadow nixpkgs packages for tools where upstream
    # release artifacts are the source of truth.
    overlays = [
      tilt-overlay.overlays.default
    ];

    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
  in
    flake-utils.lib.eachSystem systems (
      system: let
        pkgs = import nixpkgs {
          inherit overlays system;
          config = {
            allowUnfree = true;
          };
        };
      in {
        formatter = pkgs.alejandra;

        devShells.default = pkgs.mkShell {
          name = "ts-dev";
          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.jq
            pkgs.ripgrep
            pkgs.coreutils
            pkgs.tilt
            pkgs.lefthook
          ];
          # Bun 1.4.3 comes from the official installer (README Quickstart),
          # independently of the nixpkgs release channel.
          shellHook =
            ''
              export PATH="''${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
            ''
            + (pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            '')
            + (pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
              unset SDKROOT
              unset DEVELOPER_DIR
              export PATH=/usr/bin:$PATH
            '');
        };

        devShell = self.devShells.${system}.default;
      }
    );
}
