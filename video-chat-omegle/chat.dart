import 'package:flutter/material.dart';

class SparkChatPage extends StatelessWidget {
  const SparkChatPage({super.key});

  @override
  Widget build(BuildContext context) {
    const blue = Color(0xff2ea3ff);
    const border = Color(0xffe6d7c8);

    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Column(
          children: [
            // TOP BAR
            Container(
              height: 60,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(
                  bottom: BorderSide(color: Color(0xffeeeeee)),
                ),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // LOGO
                  const Row(
                    children: [
                      Text(
                        "Spark",
                        style: TextStyle(
                          color: Color(0xffff9a00),
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        "Chat",
                        style: TextStyle(
                          color: Color(0xff3fa0ff),
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),

                  Row(
                    children: [
                      // NOTIFICATION ICON
                      Stack(
                        children: [
                          const Icon(Icons.notifications, size: 28),
                          Positioned(
                            top: 2,
                            right: 2,
                            child: Container(
                              width: 10,
                              height: 10,
                              decoration: const BoxDecoration(
                                color: Colors.red,
                                shape: BoxShape.circle,
                              ),
                            ),
                          )
                        ],
                      ),
                      const SizedBox(width: 12),

                      // EXIT BUTTON
                      ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.red,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 8),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        onPressed: () {},
                        child: const Text("Exit"),
                      )
                    ],
                  )
                ],
              ),
            ),

            // BODY LAYOUT
            Expanded(
              child: Row(
                children: [
                  // LEFT SIDE (VIDEOS)
                  SizedBox(
                    width: 340,
                    child: Column(
                      children: [
                        const SizedBox(height: 10),

                        // STRANGER VIDEO
                        Expanded(
                          flex: 3,
                          child: _videoBox(
                            title: "Stranger",
                            showReport: true,
                          ),
                        ),

                        const SizedBox(height: 10),

                        // LOCAL VIDEO
                        Expanded(
                          flex: 2,
                          child: _videoBox(
                            title: "You",
                            showMic: true,
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(width: 12),

                  // RIGHT SIDE (CHAT)
                  Expanded(
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: border, width: 6),
                      ),
                      child: Column(
                        children: [
                          // CHAT MESSAGES
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              child: ListView(
                                children: [
                                  Center(
                                    child: Container(
                                      padding: const EdgeInsets.all(10),
                                      decoration: BoxDecoration(
                                        color: Colors.grey[200],
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                      child: const Text("Connecting..."),
                                    ),
                                  )
                                ],
                              ),
                            ),
                          ),

                          // INPUT AREA
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: const BoxDecoration(
                              color: Color(0xfffafafa),
                              border: Border(
                                top: BorderSide(color: Color(0xffdddddd)),
                              ),
                            ),
                            child: Column(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(
                                    color: const Color(0xfffafafa),
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(
                                      color: const Color(0xffdddddd),
                                    ),
                                  ),
                                  child: const Text(
                                    "Loading...",
                                    textAlign: TextAlign.center,
                                  ),
                                ),
                                const SizedBox(height: 8),

                                Row(
                                  children: [
                                    // SEND
                                    Container(
                                      width: 42,
                                      height: 42,
                                      decoration: BoxDecoration(
                                        color: blue,
                                        borderRadius: BorderRadius.circular(8),
                                      ),
                                      child: const Icon(Icons.send,
                                          color: Colors.white),
                                    ),
                                    const SizedBox(width: 8),

                                    // INPUT
                                    Expanded(
                                      child: TextField(
                                        enabled: false,
                                        decoration: InputDecoration(
                                          hintText: "Type...",
                                          filled: true,
                                          fillColor: Colors.white,
                                          contentPadding:
                                              const EdgeInsets.symmetric(
                                                  horizontal: 12),
                                          border: OutlineInputBorder(
                                            borderRadius:
                                                BorderRadius.circular(8),
                                            borderSide: const BorderSide(
                                                color: Color(0xffcccccc)),
                                          ),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 8),

                                    // SKIP BUTTON
                                    ElevatedButton(
                                      style: ElevatedButton.styleFrom(
                                        backgroundColor:
                                            const Color(0xffff9a00),
                                        foregroundColor: Colors.white,
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 14, vertical: 10),
                                        shape: RoundedRectangleBorder(
                                          borderRadius:
                                              BorderRadius.circular(8),
                                        ),
                                      ),
                                      onPressed: () {},
                                      child: const Text("Skip"),
                                    ),
                                  ],
                                )
                              ],
                            ),
                          )
                        ],
                      ),
                    ),
                  )
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // VIDEO BOX WIDGET
  Widget _videoBox({
    required String title,
    bool showMic = false,
    bool showReport = false,
  }) {
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xffe6d7c8), width: 6),
        color: Colors.black,
      ),
      child: Stack(
        children: [
          // Fake Video Background
          Container(color: Colors.black),

          // Label
          Positioned(
            top: 8,
            left: 8,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(title),
            ),
          ),

          // Watermark
          const Positioned(
            bottom: 10,
            left: 10,
            child: Text(
              "SparkChat",
              style: TextStyle(
                color: Colors.white70,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),

          // MIC BUTTON
          if (showMic)
            Positioned(
              bottom: 10,
              right: 10,
              child: FloatingActionButton(
                backgroundColor: const Color(0xff2ea3ff),
                onPressed: () {},
                child: const Icon(Icons.mic),
              ),
            ),

          // REPORT BUTTON
          if (showReport)
            Positioned(
              top: 10,
              right: 10,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                ),
                onPressed: () {},
                child: const Text("🚨 Report"),
              ),
            ),
        ],
      ),
    );
  }
}
