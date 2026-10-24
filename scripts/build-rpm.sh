#!/bin/bash
set -e

VERSION="0.1.0"
NAME="termchat"

echo "Building RPM for $NAME v$VERSION..."

# Create RPM build structure
mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Create source tarball
TMPDIR=$(mktemp -d)
SRCDIR="$TMPDIR/$NAME-$VERSION"
mkdir -p "$SRCDIR"

# Copy source files
cp -r *.go go.mod public/ README.md "$SRCDIR/"

# Create tarball
cd "$TMPDIR"
tar czf ~/rpmbuild/SOURCES/$NAME-$VERSION.tar.gz $NAME-$VERSION/
cd -

# Copy spec file
cp termchat.spec ~/rpmbuild/SPECS/

# Build RPM
rpmbuild -ba ~/rpmbuild/SPECS/termchat.spec

echo ""
echo "Build complete!"
echo "RPMs location: ~/rpmbuild/RPMS/"
echo "Source RPM: ~/rpmbuild/SRPMS/"
echo ""
echo "Install with: sudo rpm -ivh ~/rpmbuild/RPMS/x86_64/$NAME-$VERSION-1.*.x86_64.rpm"
echo "Or: sudo dnf install ~/rpmbuild/RPMS/x86_64/$NAME-$VERSION-1.*.x86_64.rpm"

# Cleanup
rm -rf "$TMPDIR"
