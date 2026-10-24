Name:           termchat
Version:        0.1.0
Release:        1%{?dist}
Summary:        Talk to Gemini, Copilot and DeepSeek from the terminal

License:        MIT
URL:            https://github.com/gbraad/terminal-chat
Source0:        %{name}-%{version}.tar.gz

%global debug_package %{nil}

BuildRequires:  golang >= 1.24

%description
termchat talks to Gemini, Copilot and DeepSeek chat from a terminal without
vendor API keys. A small browser extension drives the chat tab you are already
signed in to, and a loopback HTTP bridge carries prompts and answers.

The CLI can also run as a persistent server that several clients and browsers
share, and serves a small web interface on the same port.

%prep
%setup -q

%build
go build -o termchat

%install
install -D -m 0755 termchat %{buildroot}%{_bindir}/termchat

%files
%doc README.md
%{_bindir}/termchat

%changelog
* Sat Oct 24 2026 Gerard Braad <me@gbraad.nl> - 0.1.0-1
- Initial RPM release
- Go port with embedded web interface
