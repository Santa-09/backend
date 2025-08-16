package com.example.backend.service;

import com.example.backend.model.Question;
import com.example.backend.model.Reply;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.*;

@Service
public class QuestionService {
    private final Map<String, Question> questions = new HashMap<>();

    public List<Question> getAllQuestions() {
        return new ArrayList<>(questions.values());
    }

    public Question createQuestion(String text) {
        Question question = new Question();
        question.setId(UUID.randomUUID().toString());
        question.setText(text);
        question.setCreatedAt(LocalDateTime.now());
        questions.put(question.getId(), question);
        return question;
    }

    public void deleteQuestion(String id) {
        questions.remove(id);
    }

    public Reply addReply(String questionId, String text) {
        Question question = questions.get(questionId);
        if (question == null) return null;
        Reply reply = new Reply();
        reply.setId(UUID.randomUUID().toString());
        reply.setText(text);
        question.getReplies().add(reply);
        return reply;
    }

    public void deleteReply(String questionId, String replyId) {
        Question question = questions.get(questionId);
        if (question != null) {
            question.getReplies().removeIf(reply -> reply.getId().equals(replyId));
        }
    }

    public void clearAllQuestions() {
        questions.clear();
    }
}
