# Build environments for the Linux and Windows engines and packages, used by
# scripts/package-other.sh.
#
#   linux-x64    native compilers and amd64 libraries
#   linux-arm64  cross compilers and arm64 libraries (Ubuntu multiarch)
#   windows      llvm-mingw for x64 and arm64 (libraries come from MSYS2,
#                fetched by scripts/fetch-msys2-deps.py), Wine for
#                electron-builder and tests; also packages every Linux and
#                Windows build
FROM debian:bookworm AS base
ARG NODE_VERSION=22.23.3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential meson ninja-build pkg-config gettext git python3 curl ca-certificates \
      xz-utils zstd file patchelf binutils nasm \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1

# The Linux engine is built on Ubuntu 20.04 (glibc 2.31, GCC 9), the oldest
# system it then runs on; everything newer (Debian 11+, Fedora 33+, ...) works
# too. Libraries the plugins use, for one architecture (":amd64"/":arm64";
# arm64 packages come from ports.ubuntu.com). Ubuntu's meson is too old, so
# meson comes from PyPI. FFmpeg is not here: distribution builds link half the
# multimedia stack, so a small audio-only FFmpeg is built from source instead
# (scripts/build-engine-other.sh). PipeWire 0.3.33+ is newer than 20.04, so
# there is no PipeWire output plugin; PipeWire desktops play through the
# PulseAudio one (pipewire-pulse).
FROM ubuntu:20.04 AS linux-libs
ARG NODE_VERSION=22.23.3
ARG DEB_ARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i 's/^deb http/deb [arch=amd64] http/' /etc/apt/sources.list \
    && if [ "${DEB_ARCH}" = arm64 ]; then for s in focal focal-updates focal-security; do \
         echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports $s main universe" >> /etc/apt/sources.list; done; fi \
    && dpkg --add-architecture ${DEB_ARCH} && apt-get update && apt-get install -y --no-install-recommends \
      build-essential ninja-build pkg-config gettext git python3 python3-pip curl ca-certificates \
      xz-utils zstd file patchelf binutils nasm \
      libglib2.0-dev:${DEB_ARCH} libflac-dev:${DEB_ARCH} libvorbis-dev:${DEB_ARCH} libogg-dev:${DEB_ARCH} \
      libopus-dev:${DEB_ARCH} libopusfile-dev:${DEB_ARCH} libmpg123-dev:${DEB_ARCH} libsndfile1-dev:${DEB_ARCH} \
      libwavpack-dev:${DEB_ARCH} libopenmpt-dev:${DEB_ARCH} libmodplug-dev:${DEB_ARCH} libsidplayfp-dev:${DEB_ARCH} \
      libfluidsynth-dev:${DEB_ARCH} libfaad-dev:${DEB_ARCH} libcue-dev:${DEB_ARCH} libneon27-gnutls-dev:${DEB_ARCH} \
      libsoxr-dev:${DEB_ARCH} libsamplerate0-dev:${DEB_ARCH} libbs2b-dev:${DEB_ARCH} libmp3lame-dev:${DEB_ARCH} \
      libxml2-dev:${DEB_ARCH} libcurl4-gnutls-dev:${DEB_ARCH} \
      libasound2-dev:${DEB_ARCH} libpulse-dev:${DEB_ARCH} libjack-jackd2-dev:${DEB_ARCH} \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir meson==1.4.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

FROM linux-libs AS linux-x64

FROM linux-libs AS linux-arm64
RUN apt-get update && apt-get install -y --no-install-recommends crossbuild-essential-arm64 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS windows
ARG LLVM_MINGW=20261020
RUN curl -fsSL "https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW}/llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-x86_64.tar.xz" \
      | tar -xJ -C /opt && mv /opt/llvm-mingw-* /opt/llvm-mingw
ENV PATH=/opt/llvm-mingw/bin:$PATH
# Wine: NSIS runs its (32-bit) uninstaller stub with it while building the
# installer, and the tests run the Windows app under it.
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      wine wine64 wine32:i386 xvfb xauth fakeroot \
    && rm -rf /var/lib/apt/lists/*
