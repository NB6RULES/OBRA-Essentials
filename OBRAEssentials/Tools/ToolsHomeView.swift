import SwiftUI
import WebKit

/// The Tools tab: small engineering calculators. Each one is a page bundled with the app,
/// so it works offline.
struct ToolsHomeView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    UpdateBanner()
                    SectionTitle(text: "Electronics", systemImage: "bolt.fill")
                    NavigationLink {
                        VoltageDividerView()
                    } label: {
                        toolRow(icon: "divide", title: "Voltage divider",
                                detail: "Find Vout, R1 or R2, or pair resistors from your own stock to hit a target voltage.")
                    }
                    .buttonStyle(.plain)
                }
                .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Tools")
        }
    }

    private func toolRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 46, height: 46)
                .background(Theme.accentGradient, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .card()
    }
}

struct VoltageDividerView: View {
    var body: some View {
        BundledPage(path: "Tools/divider.html")
            .background(Color(red: 15 / 255, green: 16 / 255, blue: 19 / 255).ignoresSafeArea())
            .navigationTitle("Voltage divider")
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// Shows an HTML page from the app bundle. Saved values (such as the resistor list) are kept
/// in the page's local storage, which persists between launches.
struct BundledPage: UIViewRepresentable {
    let path: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 15 / 255, green: 16 / 255, blue: 19 / 255, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.keyboardDismissMode = .interactive
        web.allowsLinkPreview = false
        web.navigationDelegate = context.coordinator
        if #available(iOS 16.4, *) { web.isInspectable = true }
        if let root = Bundle.main.resourceURL {
            let file = root.appendingPathComponent(path)
            web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        // Keep the page self-contained: only its own bundled file may load.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.isFileURL == true ? .allow : .cancel
        }
    }
}
